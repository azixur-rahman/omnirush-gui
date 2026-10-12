import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { REMEMBER_MS, RECHECK_MS, RETRY_MS, UPLOAD_FORMAT_FILE, UploadFormat } from "./context/upload-format.js";
import { OmniRushGatewayBroker } from "./omnirush-gateway-broker.js";
import { SessionUploader, type TraceCapabilities } from "./session-uploader.js";

// 3.4.1 cached schema 2 for five minutes after any failed capabilities check
// (a 401 the refresh did not cure, a 5xx, a timeout during a server hiccup):
// the broker answered a failure as "the oldest backend" and the uploader
// believed it, so short runs of schema-2 uploads appeared between schema-3
// ones. The server's schema 3 is now remembered per server in the state dir
// (context/upload-format.ts, shared with the CLI); only /collect's 422
// unsupported_schema undoes it.

const SCHEMA_3: TraceCapabilities = { schema_versions: [1, 2, 3], canonical_trace: true };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

type Check = "ok" | "fail" | TraceCapabilities;

/** One run (a process) with `stateDir`: the [schema, refused] of each trace upload sent. */
async function runTraces(stateDir: string, check: Check, options: { refuse3?: boolean } = {}): Promise<Array<[number, boolean]>> {
  const root = await temp("omnirush-format-ws-");
  await writeFile(join(root, "README.md"), "# demo\n");
  const sent: Array<[number, boolean]> = [];
  const uploader = new SessionUploader({
    stateDir,
    capabilities: async () => {
      if (check === "fail") throw new Error("capabilities request failed");
      return check === "ok" ? SCHEMA_3 : check;
    },
    upload: async (_sessionId, compressed) => {
      const envelope = JSON.parse(zstdDecompressSync(compressed).toString("utf8")) as { snapshot_type: string; schema_version: number };
      const refused = envelope.snapshot_type === "trace" && envelope.schema_version === 3 && options.refuse3 === true;
      if (envelope.snapshot_type === "trace") sent.push([envelope.schema_version, refused]);
      return refused
        ? Response.json({ error: "unsupported_schema", schema_version: 3 }, { status: 422 })
        : Response.json({ ok: true }, { status: 201 });
    },
    fallbackScanMs: 60_000,
    retryBaseMs: 60_000,
  });
  const sessionId = `session-format-${Math.random().toString(36).slice(2, 10)}`;
  try {
    uploader.startSession(sessionId, "workspace-format", root);
    await uploader.idle(sessionId);
    uploader.recordTrace(sessionId, "tool.call", {});
    uploader.flushTrace(sessionId);
    await uploader.idle(sessionId);
  } finally {
    await uploader.stop();
  }
  return sent;
}

describe("the upload format when the capabilities check fails", () => {
  test("a failed check after the server advertised schema 3 still sends schema 3", async () => {
    const stateDir = await temp("omnirush-format-state-");
    expect(await runTraces(stateDir, "ok")).toEqual([[3, false]]);
    // The broker throws for a 401 after its refresh, a 5xx, a timeout (sessionUploadCapabilities strict).
    expect(await runTraces(stateDir, "fail")).toEqual([[3, false]]);
  }, 30_000);

  test("an answer without schema 3 does not undo a remembered one; /collect's 422 unsupported_schema does", async () => {
    const stateDir = await temp("omnirush-format-state-");
    expect(await runTraces(stateDir, "ok")).toEqual([[3, false]]);
    expect(await runTraces(stateDir, { schema_versions: [1, 2], canonical_trace: false })).toEqual([[3, false]]);
    expect(await runTraces(stateDir, "ok", { refuse3: true })).toEqual([[3, true], [2, false]]);
    expect(JSON.parse(await readFile(join(stateDir, UPLOAD_FORMAT_FILE), "utf8")).servers).toEqual({});
    expect(await runTraces(stateDir, "fail")).toEqual([[2, false]]);
  }, 30_000);

  test("a fresh install whose first check fails sends schema 2", async () => {
    expect(await runTraces(await temp("omnirush-format-state-"), "fail")).toEqual([[2, false]]);
  }, 30_000);
});

describe("UploadFormat (context/upload-format.ts)", () => {
  function clock() {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
  }

  test("401, 500 or a network error after an earlier success stays schema 3; asked again after RETRY_MS", async () => {
    for (const failure of [new Error("status 401"), new Error("status 500"), new TypeError("fetch failed")]) {
      const time = clock();
      let fail = false;
      let asked = 0;
      const format = new UploadFormat({ file: null, server: () => "gateway", now: time.now, probe: async () => { asked += 1; if (fail) throw failure; return SCHEMA_3; } });
      expect(await format.version()).toBe(3);
      fail = true;
      time.advance(RECHECK_MS + 1);
      expect(await format.version()).toBe(3);
      time.advance(RETRY_MS - 1);
      expect(await format.version()).toBe(3);
      expect(asked).toBe(2);
      time.advance(2);
      expect(await format.version()).toBe(3);
      expect(asked).toBe(3);
    }
  });

  test("an explicit 422 unsupported_schema downgrades; nothing known and a failed check is schema 2", async () => {
    const time = clock();
    let fail = false;
    const format = new UploadFormat({ file: null, server: () => "gateway", now: time.now, probe: async () => { if (fail) throw new Error("down"); return SCHEMA_3; } });
    expect(await format.version()).toBe(3);
    format.unsupported();
    expect(await format.version()).toBe(2);
    fail = true;
    time.advance(RECHECK_MS + 1);
    expect(await format.version()).toBe(2);
    fail = false;
    time.advance(RETRY_MS + 1);
    expect(await format.version()).toBe(3);
  });

  test("remembered on disk per server for REMEMBER_MS", async () => {
    const file = join(await temp("omnirush-format-file-"), UPLOAD_FORMAT_FILE);
    const time = clock();
    const down = async (): Promise<TraceCapabilities> => { throw new Error("503"); };
    expect(await new UploadFormat({ file, server: () => "gateway", now: time.now, probe: async () => SCHEMA_3 }).version()).toBe(3);
    expect(await new UploadFormat({ file, server: () => "gateway", now: time.now, probe: down }).version()).toBe(3);
    expect(await new UploadFormat({ file, server: () => "other", now: time.now, probe: down }).version()).toBe(2);
    time.advance(REMEMBER_MS + 1);
    expect(await new UploadFormat({ file, server: () => "gateway", now: time.now, probe: down }).version()).toBe(2);
  });
});

describe("the broker's capabilities for the uploader", () => {
  function broker(answers: Array<number | "network" | "ok">) {
    let probes = 0;
    const instance = new OmniRushGatewayBroker({
      credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "access-token", refreshToken: "refresh-token" },
      engineToken: "local-engine-token",
      fetch: async (input) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname.endsWith("/collect/capabilities")) {
          probes += 1;
          const next = answers.shift() ?? "ok";
          if (next === "network") throw new TypeError("fetch failed");
          if (next === "ok") return Response.json(SCHEMA_3);
          return new Response("{}", { status: next });
        }
        // The refresh cannot rotate right now (the account server is busy).
        if (pathname.endsWith("/device/refresh")) return new Response("{}", { status: 503 });
        return Response.json({ output: [] });
      },
    });
    return { instance, probes: () => probes };
  }

  test("a failed check throws for the uploader (strict) instead of answering schema 2", async () => {
    for (const failure of [401, 500, "network"] as const) {
      const { instance } = broker([failure, failure, failure]);
      await expect(instance.sessionUploadCapabilities({ strict: true })).rejects.toThrow();
    }
  });

  test("a failed check is asked again after 30 s, not after 5 minutes", async () => {
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    try {
      const { instance, probes } = broker([500]);
      await expect(instance.sessionUploadCapabilities({ strict: true })).rejects.toThrow();
      const asked = probes();
      // Within the retry window: no new request, and the other callers still read the oldest backend.
      expect(await instance.sessionUploadCapabilities()).toEqual({ schema_versions: [1, 2], canonical_trace: false });
      expect(probes()).toBe(asked);
      now += 30_001;
      expect((await instance.sessionUploadCapabilities({ strict: true })).canonical_trace).toBe(true);
      expect(probes()).toBe(asked + 1);
    } finally {
      Date.now = originalNow;
    }
  });
});
