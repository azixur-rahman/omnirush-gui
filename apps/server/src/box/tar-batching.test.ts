import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { Box, boxKey } from "./box.js";
import { TAR_END_BYTES, TAR_REQUEST_MAX_BYTES, requestLine, tarBatches, tarTo, type BoxEndpoint } from "./client.js";
import { boxRun, type ReadyPlan } from "./launch.js";
import { BoxService, type BoxWorkspace } from "./service.js";

// A checkpoint whose changed paths do not fit in one boxd request line
// (client.ts tarBatches/tarTo; the CLI's src/box/client.js is the same):
// boxd refused a first line over 4 MiB, which a fresh node_modules passes.
// The paths go out in several tar requests into one file that is a single
// valid tar; a tar that still fails leaves the checkpoint without a tar, its
// paths listed and tried again next time, and the prompt goes on. A fake
// boxd speaks the wire format and writes tars the way boxd does
// (archive/tar: 512-byte blocks, two zero blocks at the end, no record
// padding), with boxd's old 4 MiB line limit.

const BOXD_LINE_MAX = 4 << 20;
const frame = (kind: number, payload: Buffer) => {
  const head = Buffer.alloc(5);
  head[0] = kind;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
};
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const tmp = (name = "tarbatch") => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `omnirush-${name}-`));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// --- a tar the way boxd writes one ---------------------------------------------

type FakeFile = { path: string; type: string; mode: number; size?: number; mtime_ns?: number; ctime_ns?: number; uid: number; gid: number; data?: Buffer };

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name: string, { size = 0, type = "0" }: { size?: number; type?: string } = {}): Buffer {
  const block = Buffer.alloc(512);
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  block.write(base, 0, 100, "utf8");
  block.write(octal(0o644, 8), 100, "latin1");
  block.write(octal(0, 8), 108, "latin1");
  block.write(octal(0, 8), 116, "latin1");
  block.write(octal(size, 12), 124, "latin1");
  block.write(octal(0, 12), 136, "latin1");
  block.fill(0x20, 148, 156);
  block.write(type, 156, "latin1");
  block.write("ustar\u000000", 257, "latin1");
  block.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return block;
}

/** writeTar's output for `paths`: sorted, existing ones only, then archive/tar's Close (two zero blocks). */
function boxdTar(files: Map<string, FakeFile>, paths: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const p of [...paths].sort(byteOrder)) {
    const file = files.get(p);
    if (!file) continue; // gone meanwhile
    if (file.type === "dir") {
      parts.push(header(`${p.slice(1)}/`, { type: "5" }));
      continue;
    }
    const data = file.data ?? Buffer.alloc(0);
    parts.push(header(p.slice(1), { size: data.length }), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** The members of a tar and where its end blocks are; fails on anything but one tar. */
function readTar(buf: Buffer): { members: Array<{ name: string; type: string; data: Buffer }>; end: number } {
  const members: Array<{ name: string; type: string; data: Buffer }> = [];
  let at = 0;
  for (;;) {
    expect(at + 512).toBeLessThanOrEqual(buf.length);
    const block = buf.subarray(at, at + 512);
    if (block.every((byte) => byte === 0)) {
      expect(buf.subarray(at, at + 1024).length).toBe(1024);
      expect(buf.subarray(at, at + 1024).every((byte) => byte === 0)).toBe(true);
      return { members, end: at };
    }
    const field = (start: number, length: number) => block.subarray(start, start + length).toString("utf8").replace(/\0[\s\S]*$/, "");
    const prefix = field(345, 155);
    const name = (prefix ? `${prefix}/` : "") + field(0, 100);
    const size = parseInt(field(124, 12), 8) || 0;
    at += 512;
    members.push({ name, type: field(156, 1) || "0", data: Buffer.from(buf.subarray(at, at + size)) });
    at += Math.ceil(size / 512) * 512;
  }
}

// --- a fake boxd --------------------------------------------------------------------

/**
 * changes/stat/walk/tar over the wire format, on an in-memory box. Refuses a
 * request line over 4 MiB as the old boxd does. `failTar(n)`: the n-th tar
 * request (1-based) fails; `delayMs` holds each tar request.
 */
async function fakeBoxd({ lineMax = BOXD_LINE_MAX, failTar = () => false, delayMs = 0, warn = null }: { lineMax?: number; failTar?: (n: number) => boolean; delayMs?: number; warn?: string | null } = {}) {
  const files = new Map<string, FakeFile>();
  const lines: Buffer[] = [];
  let tars = 0;
  let clock = 1_000;
  const write = (p: string, data = Buffer.from(`${p}\n`)) => {
    clock += 1;
    files.set(p, { path: p, type: "file", mode: 0o644, size: data.length, mtime_ns: clock, ctime_ns: clock, uid: 0, gid: 0, data });
  };
  const stat = (p: string) => {
    const file = files.get(p);
    if (!file) return { path: p, type: "missing" };
    const { data: _data, ...entry } = file;
    return entry;
  };
  const server = net.createServer((socket) => {
    socket.on("error", () => undefined);
    let chunks: Buffer[] | null = [];
    let size = 0;
    socket.on("data", async (chunk: Buffer) => {
      if (!chunks) return;
      chunks.push(chunk);
      size += chunk.length;
      const all = Buffer.concat(chunks);
      const nl = all.indexOf(0x0a);
      if (nl < 0 && size <= lineMax + 1) return;
      chunks = null;
      const fail = (text: string) => socket.end(Buffer.concat([frame(0x45, Buffer.from(text)), frame(0x78, Buffer.from(JSON.stringify({ code: 125, ms: 1 })))]));
      if (nl < 0 || nl > lineMax) return fail("request line too long");
      const line = all.subarray(0, nl + 1);
      lines.push(line);
      const req = JSON.parse(line.toString("utf8"));
      let data: Buffer = Buffer.alloc(0);
      let stderr: string | null = null;
      if (req.op === "changes") data = Buffer.from(JSON.stringify([...files.keys()].map((p) => ({ kind: "A", ...stat(p) }))));
      else if (req.op === "stat") data = Buffer.from(JSON.stringify(req.paths.map(stat)));
      else if (req.op === "walk") data = Buffer.from(JSON.stringify({ entries: [], truncated: false }));
      else if (req.op === "tar") {
        tars += 1;
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (failTar(tars)) return fail("tar: no space left on device");
        data = boxdTar(files, req.paths);
        stderr = warn;
      }
      const out: Buffer[] = [];
      if (stderr) out.push(frame(0x65, Buffer.from(stderr)));
      for (let i = 0; i < data.length; i += 256 << 10) out.push(frame(0x64, data.subarray(i, i + (256 << 10))));
      out.push(frame(0x78, Buffer.from(JSON.stringify({ code: 0, ms: 2 }))));
      socket.end(Buffer.concat(out));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  const box: BoxEndpoint = { host: "127.0.0.1", port: typeof address === "object" && address ? address.port : 0, token: "tok" };
  return { box, files, lines, write, tarLines: () => lines.filter((line) => JSON.parse(line.toString("utf8")).op === "tar") };
}

/** `n` paths like a fresh node_modules (scoped and plain packages, ~100-130 bytes each). */
function nodeModules(n: number, root = "/home/user/projects/my-vite-react-app"): string[] {
  const areas = ["components", "utils", "helpers", "internal", "runtime", "plugins", "transforms", "esm", "cjs", "types"];
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const pkg = Math.floor(i / 100);
    const scope = pkg % 3 === 0 ? `@scope-${pkg % 17}/` : "";
    out.push(`${root}/node_modules/${scope}package-name-${pkg}/dist/${areas[i % areas.length]}/module-file-${i % 100}.js`);
  }
  return out;
}

const lineBytes = (box: BoxEndpoint, paths: string[]) => Buffer.byteLength(requestLine(box, { op: "tar", paths }));

describe("box tar batching", () => {
  test("tarBatches: a request that fits is one batch, the paths as given", () => {
    const box = { port: 1, token: "tok" };
    const paths = ["/b", "/a", "/c/é"];
    const batches = tarBatches(box, paths);
    expect(batches.length).toBe(1);
    expect(batches[0]).toBe(paths);
  });

  test("tarBatches: just under, at, just over and far over the budget", () => {
    const box = { port: 1, token: "tok" };
    const paths = nodeModules(2_000);
    const line = lineBytes(box, paths);
    expect(tarBatches(box, paths, { maxBytes: line })[0]).toBe(paths);
    expect(tarBatches(box, paths, { maxBytes: line + 1 }).length).toBe(1);
    const sorted = [...paths].sort(byteOrder);
    expect(tarBatches(box, paths, { maxBytes: line - 1 })).toEqual([sorted.slice(0, -1), sorted.slice(-1)]);
    for (const budget of [line - 1, Math.floor(line / 3), 4_096]) {
      const batches = tarBatches(box, paths, { maxBytes: budget });
      for (const [index, batch] of batches.entries()) {
        expect(lineBytes(box, batch)).toBeLessThanOrEqual(budget);
        // Full: the next path would not have fit.
        if (index < batches.length - 1) expect(lineBytes(box, [...batch, batches[index + 1][0]])).toBeGreaterThan(budget);
      }
      expect(batches.flat()).toEqual(sorted);
    }
  });

  test("tarBatches: 60,000 node_modules paths at the default budget stay under 2 MiB per request, each path once", () => {
    const box = { port: 1, token: "0123456789abcdef0123456789abcdef0123456789abcdef" };
    const paths = nodeModules(60_000);
    const whole = lineBytes(box, paths);
    expect(whole).toBeGreaterThan(BOXD_LINE_MAX);
    const batches = tarBatches(box, paths);
    expect(batches.length).toBe(Math.ceil(whole / TAR_REQUEST_MAX_BYTES));
    for (const batch of batches) expect(lineBytes(box, batch)).toBeLessThanOrEqual(TAR_REQUEST_MAX_BYTES);
    expect(new Set(batches.flat()).size).toBe(paths.length);
    expect(batches.flat().length).toBe(paths.length);
  });

  test("tarBatches: sizes are bytes of the JSON line, the order is boxd's byte order", () => {
    const box = { port: 1, token: "tok" };
    const paths = ["/x/￿", "/x/😀", "/x/é", "/x/a\"b", "/x/a\\b", "/x/tab\there", "/x/z"];
    const budget = lineBytes(box, []) + 20;
    const batches = tarBatches(box, paths, { maxBytes: budget });
    for (const batch of batches) expect(lineBytes(box, batch) <= budget || batch.length === 1).toBe(true);
    // UTF-8 byte order puts U+FFFF before the emoji (UTF-16 order would not).
    expect(batches.flat()).toEqual(["/x/a\"b", "/x/a\\b", "/x/tab\there", "/x/z", "/x/é", "/x/￿", "/x/😀"]);
    // A path longer than the budget on its own still gets a request.
    const long = `/x/${"y".repeat(500)}`;
    expect(tarBatches(box, ["/a", long, "/b"], { maxBytes: 100 })).toEqual([["/a", "/b"], [long]]);
  });

  test("tarTo: a list that fits sends today's request, byte for byte, and writes boxd's tar as it is", async () => {
    const boxd = await fakeBoxd();
    const paths = ["/opt/b.txt", "/opt/a.txt", "/opt/sub"];
    boxd.write("/opt/a.txt");
    boxd.write("/opt/b.txt");
    boxd.files.set("/opt/sub", { path: "/opt/sub", type: "dir", mode: 0o755, uid: 0, gid: 0 });
    const file = path.join(tmp(), "turn.tar");
    const result = await tarTo(boxd.box, paths, file);
    expect(boxd.tarLines().map(String)).toEqual([`${JSON.stringify({ v: 1, token: "tok", op: "tar", paths })}\n`]);
    const written = readFileSync(file);
    expect(written.equals(boxdTar(boxd.files, paths))).toBe(true);
    expect({ bytes: result.bytes, sha256: result.sha256, batches: result.batches, warning: result.warning }).toEqual({ bytes: written.length, sha256: sha256(written), batches: 1, warning: null });
  });

  test("tarTo: one request for 50,000 node_modules paths is refused by the old boxd (request line too long)", async () => {
    const boxd = await fakeBoxd();
    const paths = nodeModules(50_000);
    for (const p of paths) boxd.write(p);
    expect(lineBytes(boxd.box, paths)).toBeGreaterThan(BOXD_LINE_MAX);
    await expect(tarTo(boxd.box, paths, path.join(tmp(), "turn.tar"), { maxRequestBytes: Infinity })).rejects.toThrow(/^box tar failed: request line too long$/);
  });

  test("tarTo: 50,000 paths in batches make one valid tar: every file once, in order, bytes and sha256 of the file", async () => {
    const boxd = await fakeBoxd({ warn: "busy: a command was running during the snapshot\n" });
    const paths = nodeModules(50_000);
    for (const p of paths) boxd.write(p);
    boxd.files.delete(paths[123]); // gone meanwhile: boxd skips it
    const file = path.join(tmp(), "turn.tar");
    const result = await tarTo(boxd.box, paths, file);
    const lines = boxd.tarLines();
    expect(result.batches).toBe(lines.length);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(TAR_REQUEST_MAX_BYTES);
    expect(result.requestBytes).toBe(Math.max(...lines.map((line) => line.length)));
    const written = readFileSync(file);
    expect(result.bytes).toBe(written.length);
    expect(result.sha256).toBe(sha256(written));
    // The same bytes one request with no line limit would give.
    expect(written.equals(boxdTar(boxd.files, paths))).toBe(true);
    const { members, end } = readTar(written);
    expect(end + TAR_END_BYTES).toBe(written.length);
    const want = paths.filter((p) => boxd.files.has(p)).sort(byteOrder);
    expect(members.map((m) => `/${m.name}`)).toEqual(want);
    expect(members[7].data.toString()).toBe(`${want[7]}\n`);
    expect(result.warning).toBe("busy: a command was running during the snapshot");
    const gnu = spawnSync("tar", ["-tf", file], { encoding: "utf8", maxBuffer: 64 << 20 });
    if (gnu.status !== null && !gnu.error) {
      expect(gnu.status).toBe(0);
      expect(gnu.stdout.trim().split("\n").map((name) => `/${name}`)).toEqual(want);
    }
  });

  test("tarTo: a failed batch fails the tar and names the request", async () => {
    const boxd = await fakeBoxd({ failTar: (n) => n === 2 });
    const paths = nodeModules(50_000);
    for (const p of paths) boxd.write(p);
    const batches = tarBatches(boxd.box, paths).length;
    await expect(tarTo(boxd.box, paths, path.join(tmp(), "turn.tar"))).rejects.toThrow(new RegExp(`^box tar failed \\(request 2 of ${batches}\\): tar: no space left on device$`));
    expect(boxd.tarLines().length).toBe(2);
  });

  test("tarTo: timeoutMs bounds the whole tar, not each request", async () => {
    const boxd = await fakeBoxd({ delayMs: 150 });
    const paths = nodeModules(3_000);
    for (const p of paths) boxd.write(p);
    const maxRequestBytes = Math.ceil(lineBytes(boxd.box, paths) / 4);
    expect(tarBatches(boxd.box, paths, { maxBytes: maxRequestBytes }).length).toBeGreaterThanOrEqual(4);
    await expect(tarTo(boxd.box, paths, path.join(tmp(), "turn.tar"), { maxRequestBytes, timeoutMs: 400 })).rejects.toThrow(/timed out/);
  });
});

// --- the checkpoint and the prompt ---------------------------------------------------------

function readyBox(boxd: Awaited<ReturnType<typeof fakeBoxd>>, work: string, env: Record<string, string> = {}, root = path.join(work, "project")) {
  const logs: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const box = new Box({ key: boxKey(root), name: "omnirush-box-k1", root, croot: root, runtime: { name: "docker", bin: "docker" }, home: path.join(work, "home"), runFolder: path.join(work, "run"), run: async () => ({ code: 0, stdout: "", stderr: "" }), log: (level, message, fields) => logs.push({ level, message, fields }), platform: "linux", env });
  box.connect({ port: boxd.box.port, token: boxd.box.token, uid: 0, gid: 0, containerId: "c1", imageId: "img" });
  box.setState("ready", null);
  return { box, logs, snaps: path.join(work, "snaps") };
}

describe("box checkpoint tar", () => {
  test("50,000 new files go out in batches; the turn's tar lists every one", async () => {
    const boxd = await fakeBoxd();
    const { box, snaps } = readyBox(boxd, tmp());
    const paths = nodeModules(50_000, "/usr/local/lib/app");
    for (const p of paths) boxd.write(p);
    (await box.checkpoint(snaps, 1)).commit();
    const summary = JSON.parse(readFileSync(path.join(snaps, "turn-1.json"), "utf8"));
    const written = readFileSync(path.join(snaps, "turn-1.tar"));
    expect(summary.bytes).toBe(written.length);
    expect(summary.sha256).toBe(sha256(written));
    expect(summary.delta.changed.length).toBe(50_000);
    expect(summary.stats.tar_requests).toBeGreaterThanOrEqual(3);
    expect(summary.stats.tar_error).toBeUndefined();
    expect(readTar(written).members.map((m) => `/${m.name}`)).toEqual([...summary.delta.changed].sort(byteOrder));
  });

  test("a tar that fails leaves the checkpoint without one, lists its paths and copies them at the next checkpoint", async () => {
    let failing = false;
    const boxd = await fakeBoxd({ failTar: () => failing });
    const { box, logs, snaps } = readyBox(boxd, tmp());
    boxd.write("/opt/app/one.txt");
    (await box.checkpoint(snaps, 1)).commit();
    failing = true;
    boxd.write("/opt/app/two.txt");
    boxd.write("/opt/app/three.txt");
    const t2 = await box.checkpoint(snaps, 2);
    expect(t2.summary).toMatchObject({ tar: null, bytes: 0, sha256: null, delta: { changed: [] }, checkpoint: { status: "complete" } });
    expect(t2.summary.skipped.map(({ path: p, reason }) => [p, reason])).toEqual([["/opt/app/three.txt", "tar_failed"], ["/opt/app/two.txt", "tar_failed"]]);
    expect(t2.summary.stats.tar_error).toBe("box tar failed: tar: no space left on device");
    expect(logs.some((entry) => entry.level === "warn" && /tar failed/.test(entry.message) && entry.fields?.paths === 2)).toBe(true);
    t2.commit();
    expect(readdirSync(snaps).filter((name) => name.startsWith("turn-2")).sort()).toEqual(["turn-2.json"]);
    failing = false;
    const t3 = await box.checkpoint(snaps, 3);
    expect(t3.summary.delta.changed).toEqual(["/opt/app/three.txt", "/opt/app/two.txt"]);
    expect(t3.summary.delta.parent).toBe(t2.summary.checkpoint.id as string);
    t3.commit();
    expect(readTar(readFileSync(path.join(snaps, "turn-3.tar"))).members.map((m) => m.name)).toEqual(["opt/app/three.txt", "opt/app/two.txt"]);
  });

  test("a prompt whose checkpoint tar fails still goes out; the chat's next prompt copies what it missed", async () => {
    let failing = false;
    const boxd = await fakeBoxd({ failTar: () => failing });
    const work = tmp("tarprompt");
    const root = path.join(work, "project");
    const { box } = readyBox(boxd, work, {}, root);
    const stateDir = path.join(work, "state");
    const workspace: BoxWorkspace = { id: "ws_t", path: root, workspaceType: "local" };
    const logs: Array<{ level: string; message: string }> = [];
    const boxes = new BoxService({
      stateDir,
      readSettings: async () => ({ mode: "on", offered: true }),
      writeSettings: async () => {},
      workspaces: () => [workspace],
      pluginPath: () => "/plugins/omnirush-box.js",
      env: { OMNIRUSH_BOX_HOME: path.join(work, "home"), PATH: "", OMNIRUSH_BOX_RUNTIME: "/nonexistent/docker" },
      folderReplaced: async () => false,
      log: (level: "info" | "warn" | "error", message: string) => logs.push({ level, message }),
    });
    const plan: ReadyPlan = { box: { key: boxKey(root), home: path.join(work, "home"), root, runtime: { name: "docker", bin: "docker" } as ReadyPlan["box"]["runtime"] }, notice: null, shell: "/bin/sh", start: async () => box, phase: "ready" };
    const run = boxRun(plan, { tmpRoot: path.join(work, "pending") });
    boxes["projects"].set(boxKey(root), { run, notice: null, planning: null, nextPlanAt: 0, waitingImage: false });
    const sessionId = "ses_tarfail01";
    const snaps = path.join(stateDir, "sandbox", "snapshots", sessionId);
    boxd.write("/opt/app/one.txt");
    expect(await boxes.beforePrompt(sessionId, workspace)).not.toBeNull();
    failing = true;
    for (const p of nodeModules(50_000)) boxd.write(p);
    // The tar fails: the prompt is not held back and its checkpoint is saved, saying so.
    expect(await boxes.beforePrompt(sessionId, workspace)).not.toBeNull();
    const turn2 = JSON.parse(readFileSync(path.join(snaps, "turn-2.json"), "utf8"));
    expect(turn2.tar).toBeNull();
    expect(turn2.stats.tar_error).toMatch(/^box tar failed \(request 1 of \d+\): tar: no space left on device$/);
    expect(turn2.skipped.filter((item: { reason: string }) => item.reason === "tar_failed").length).toBe(50_000);
    expect(logs.some((entry) => entry.message === "box checkpoint failed")).toBe(false);
    failing = false;
    expect(await boxes.beforePrompt(sessionId, workspace)).not.toBeNull();
    const turn3 = JSON.parse(readFileSync(path.join(snaps, "turn-3.json"), "utf8"));
    expect(turn3.delta.changed.length).toBe(50_000);
    expect(turn3.stats.tar_requests).toBeGreaterThanOrEqual(3);
    expect(readTar(readFileSync(path.join(snaps, "turn-3.tar"))).members.length).toBe(50_000);
  });
});
