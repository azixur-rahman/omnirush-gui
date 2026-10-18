// Ported from the CLI (omnirush-cli src/box/client.js, feat/local-box);
// keep the two in step. Only types were added here.
//
// The host side of boxd's wire format (box/go/proto): one TCP connection per
// operation, a JSON request line, then type+length frames. The engine's
// shell calls go through the native client (boxsh); this one is for the
// launcher: readiness, the snapshot's stat/walk/tar, and toolchain probes.

import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import net from "node:net";

export const PROTO_VERSION = 1;
const T = { stdout: 0x6f, stderr: 0x65, exit: 0x78, data: 0x64, fail: 0x45, stdinEof: 0x63, signal: 0x73 };

export type BoxEndpoint = { host?: string; port: number; token: string };
export type BoxRequest = { op: string; argv?: string[]; cwd?: string; env?: Record<string, string>; paths?: string[]; wait?: number; root?: boolean };
export type BoxExit = { code: number; ms?: number };
export type BoxReply = { exit: BoxExit; stdout: string; stderr: string; data: Buffer };
export type BoxStat = { path: string; type: string; mode?: number; size?: number; uid?: number; gid?: number; link?: string; mtime_ns?: number | string; ctime_ns?: number | string };
export type BoxChange = BoxStat & { kind: "A" | "C" | "D" };

/**
 * The most a tar request line may hold (bytes, newline included). boxd
 * refused a first line over 4 MiB ("request line too long", box/go/proto;
 * 64 MiB now, but a box keeps the boxd it was started or created with), and
 * ~30k changed paths (a fresh node_modules) are past that. A longer list
 * goes out in several requests (tarTo).
 */
export const TAR_REQUEST_MAX_BYTES = 2 * 1024 * 1024;

/**
 * How boxd ends a tar: archive/tar's Writer.Close writes two 512-byte zero
 * blocks and no record padding (box/go/cmd/boxd writeTar). A batched tar
 * drops it from every request but the last, so the file is one archive.
 */
export const TAR_END_BYTES = 1024;

/** The first line of a connection for `req`, exactly as request() sends it. */
export function requestLine(box: BoxEndpoint, req: BoxRequest): string {
  return `${JSON.stringify({ v: PROTO_VERSION, token: box.token, ...req })}\n`;
}

function frame(kind: number, payload = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(5);
  head[0] = kind;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

/**
 * One operation: resolves { exit, stdout, stderr, data } where data is the
 * concatenated Data frames (unless onData takes them). Rejects when the box
 * cannot be reached or closes early. An onData that returns a promise holds
 * the connection (backpressure) until it settles; a rejection fails the call.
 */
export function request(
  box: BoxEndpoint,
  req: BoxRequest,
  { onData, onStdout, onStderr, timeoutMs = 30_000, signal }: { onData?: (chunk: Buffer) => Promise<unknown> | null | void; onStdout?: (chunk: Buffer) => void; onStderr?: (chunk: Buffer) => void; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<BoxReply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: box.host || "127.0.0.1", port: box.port });
    socket.setNoDelay(true);
    let buffered: Buffer = Buffer.alloc(0);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const data: Buffer[] = [];
    let settled = false;
    const finish = <V>(fn: (value: V) => void, value: V) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      socket.destroy();
      fn(value);
    };
    const onAbort = () => finish(reject, new Error("aborted"));
    signal?.addEventListener?.("abort", onAbort, { once: true });
    const timer = setTimeout(() => finish(reject, new Error(`box ${req.op} timed out after ${timeoutMs} ms`)), timeoutMs);
    socket.once("connect", () => {
      socket.write(requestLine(box, req));
      if (req.op === "exec") socket.write(frame(T.stdinEof));
    });
    socket.on("error", (error) => finish(reject, error));
    socket.on("close", () => finish(reject, new Error(`box closed the ${req.op} connection early`)));
    socket.on("data", (chunk: Buffer) => {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
      while (buffered.length >= 5) {
        const size = buffered.readUInt32BE(1);
        if (buffered.length < 5 + size) break;
        const kind = buffered[0];
        const payload = buffered.subarray(5, 5 + size);
        buffered = buffered.subarray(5 + size);
        if (kind === T.stdout) (onStdout ? onStdout(payload) : out.push(Buffer.from(payload)));
        else if (kind === T.stderr || kind === T.fail) (onStderr ? onStderr(payload) : err.push(Buffer.from(payload)));
        else if (kind === T.data) {
          if (onData) {
            let wait: Promise<unknown> | null | void;
            try { wait = onData(payload); } catch (error) { finish(reject, error); return; }
            if (wait && typeof wait.then === "function" && !socket.isPaused()) {
              socket.pause();
              wait.then(() => { if (!settled) socket.resume(); }, (error: unknown) => finish(reject, error));
            }
          } else data.push(Buffer.from(payload));
        } else if (kind === T.exit) {
          let exit: BoxExit = { code: 0 };
          try { exit = JSON.parse(payload.toString("utf8")); } catch { /* keep */ }
          finish(resolve, { exit, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), data: Buffer.concat(data) });
          return;
        }
      }
    });
  });
}

/** boxd's identity, or null when it does not answer. */
export async function ping(box: BoxEndpoint, { timeoutMs = 2_000 }: { timeoutMs?: number } = {}): Promise<Record<string, unknown> | null> {
  try {
    const result = await request(box, { op: "ping" }, { timeoutMs });
    return JSON.parse(result.data.toString("utf8"));
  } catch {
    return null;
  }
}

export type ExecResult = { code: number; stdout: string; stderr: string; ms?: number };

/** Run a command in the box: { code, stdout, stderr, ms }. */
export async function exec(box: BoxEndpoint, argv: string[], { cwd, env, root = false, timeoutMs = 60_000 }: { cwd?: string; env?: Record<string, string>; root?: boolean; timeoutMs?: number } = {}): Promise<ExecResult> {
  const result = await request(box, { op: "exec", argv, ...(cwd ? { cwd } : {}), ...(env ? { env } : {}), ...(root ? { root: true } : {}) }, { timeoutMs });
  return { code: result.exit.code, stdout: result.stdout, stderr: result.stderr, ms: result.exit.ms };
}

/** lstat of each path, in order (type "missing" for a path that is gone). */
export async function stat(box: BoxEndpoint, paths: string[], { timeoutMs = 60_000 }: { timeoutMs?: number } = {}): Promise<BoxStat[]> {
  const out: BoxStat[] = [];
  for (let i = 0; i < paths.length; i += 20_000) {
    const result = await request(box, { op: "stat", paths: paths.slice(i, i + 20_000) }, { timeoutMs });
    out.push(...JSON.parse(result.data.toString("utf8")));
  }
  return out;
}

/**
 * What differs from the image ({ kind: A|C|D, path, ...stat }), walked by
 * boxd against the index it took at the box's first start; `skip` folders
 * are not walked (their `keep` subfolders are). Null when boxd cannot (an
 * older box with no index): the caller uses the runtime's `diff`.
 */
export async function changes(box: BoxEndpoint, skip: string[], keep: string[], { timeoutMs = 120_000 }: { timeoutMs?: number } = {}): Promise<BoxChange[] | null> {
  try {
    const result = await request(box, { op: "changes", paths: skip, env: { keep: keep.join(",") } }, { timeoutMs });
    if (result.exit.code !== 0) return null;
    return JSON.parse(result.data.toString("utf8"));
  } catch {
    return null;
  }
}

/** Every entry below the folders, stat fields included. */
export async function walk(box: BoxEndpoint, roots: string[], { max = 400_000, timeoutMs = 120_000 }: { max?: number; timeoutMs?: number } = {}): Promise<{ entries?: BoxStat[]; truncated?: boolean }> {
  const result = await request(box, { op: "walk", paths: roots, wait: max }, { timeoutMs });
  return JSON.parse(result.data.toString("utf8"));
}

/**
 * The tar requests for `paths`: one when its line fits in `maxBytes` (the
 * paths as given, the request exactly as before), else consecutive slices of
 * the paths in boxd's own order (byte order: it sorts each request), each
 * request line at most `maxBytes`. Batches in that order make the same
 * member order as one request would. A single path too long for a request
 * of its own still gets one (boxd says whether it takes it).
 */
export function tarBatches(box: BoxEndpoint, paths: string[], { maxBytes = TAR_REQUEST_MAX_BYTES }: { maxBytes?: number } = {}): string[][] {
  if (Buffer.byteLength(requestLine(box, { op: "tar", paths })) <= maxBytes) return [paths];
  const sorted = paths.map((p) => ({ p, b: Buffer.from(p, "utf8") })).sort((x, y) => Buffer.compare(x.b, y.b)).map(({ p }) => p);
  // The line grows by each path's JSON plus a comma between paths.
  const empty = Buffer.byteLength(requestLine(box, { op: "tar", paths: [] }));
  const batches: string[][] = [];
  let batch: string[] = [];
  let size = empty;
  for (const p of sorted) {
    const own = Buffer.byteLength(JSON.stringify(p));
    if (batch.length && size + 1 + own > maxBytes) {
      batches.push(batch);
      batch = [];
      size = empty;
    }
    size += (batch.length ? 1 : 0) + own;
    batch.push(p);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export type TarResult = { bytes: number; sha256: string; ms: number; warning: string | null; batches: number; requestBytes: number };

/**
 * Tar exactly these paths into `file`: { bytes, sha256, ms, warning, batches,
 * requestBytes }. The tar streams to disk: the box's connection waits while
 * the file catches up. A path list too long for one request line goes out
 * in several (tarBatches) into the same file: each batch's end-of-archive
 * blocks are dropped but the last one's, so `file` is one tar; `bytes` and
 * `sha256` describe that file, `warning` joins the batches' distinct ones,
 * `ms` is boxd's time summed, `requestBytes` the longest request line.
 * `timeoutMs` bounds the whole tar, however many requests it takes. A failed
 * batch fails the call (`file` is then incomplete).
 */
export async function tarTo(box: BoxEndpoint, paths: string[], file: string, { timeoutMs = 15 * 60_000, maxRequestBytes = TAR_REQUEST_MAX_BYTES }: { timeoutMs?: number; maxRequestBytes?: number } = {}): Promise<TarResult> {
  const batches = tarBatches(box, paths, { maxBytes: maxRequestBytes });
  const deadline = Date.now() + timeoutMs;
  const stream = createWriteStream(file, { mode: 0o600 });
  const hash = createHash("sha256");
  const controller = new AbortController();
  let bytes = 0;
  let draining: Promise<unknown> | null = null;
  let failed: Error | null = null;
  stream.on("error", (error) => {
    failed ??= error;
    controller.abort();
  });
  await once(stream, "open");
  const write = (chunk: Buffer): Promise<unknown> | null => {
    if (!chunk.length) return draining;
    hash.update(chunk);
    bytes += chunk.length;
    // One drain wait at a time, however many frames arrive before it.
    if (!stream.write(chunk) && !draining) {
      draining = once(stream, "drain").finally(() => { draining = null; });
      draining.catch(() => undefined); // a write error is `failed`
    }
    return draining;
  };
  const warnings: string[] = [];
  let ms = 0;
  let requestBytes = 0;
  try {
    for (let index = 0; index < batches.length; index += 1) {
      const last = index === batches.length - 1;
      const req: BoxRequest = { op: "tar", paths: batches[index] };
      requestBytes = Math.max(requestBytes, Buffer.byteLength(requestLine(box, req)));
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`box tar timed out after ${timeoutMs} ms`);
      // Every batch but the last holds back its final TAR_END_BYTES (the end blocks) until it ends.
      let held: Buffer = Buffer.alloc(0);
      let result: BoxReply;
      try {
        result = await request(box, req, {
          timeoutMs: left,
          signal: controller.signal,
          onData: (chunk) => {
            const copy = Buffer.from(chunk);
            if (last) return write(copy);
            const all = held.length ? Buffer.concat([held, copy]) : copy;
            const keep = Math.min(TAR_END_BYTES, all.length);
            held = Buffer.from(all.subarray(all.length - keep));
            return write(all.subarray(0, all.length - keep));
          },
        });
      } catch (error) {
        if (failed) throw failed;
        if (batches.length > 1 && error instanceof Error) error.message += ` (request ${index + 1} of ${batches.length})`;
        throw error;
      }
      if (failed) throw failed;
      const stderr = result.stderr.trim();
      const where = batches.length > 1 ? ` (request ${index + 1} of ${batches.length})` : "";
      if (result.exit.code !== 0) throw new Error(`box tar failed${where}: ${stderr || result.exit.code}`);
      if (!last && (held.length !== TAR_END_BYTES || held.some((byte) => byte !== 0))) {
        throw new Error(`box tar failed${where}: the tar did not end with its ${TAR_END_BYTES} zero bytes`);
      }
      if (stderr && !warnings.includes(stderr)) warnings.push(stderr);
      ms += Number(result.exit.ms) || 0;
    }
  } finally {
    await new Promise<void>((resolve) => stream.end(() => resolve()));
  }
  if (failed) throw failed;
  return { bytes, sha256: hash.digest("hex"), ms, warning: warnings.join("\n") || null, batches: batches.length, requestBytes };
}
