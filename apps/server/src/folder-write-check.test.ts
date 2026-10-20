import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import path, { join } from "node:path";

import {
  checkFolderWritable,
  classifyFailure,
  controlledFolderAccessOn,
  folderWriteGate,
  isolatedBunArgs,
  probeInProcess,
  probeWithEngine,
  readOnlyPrompt,
  resetFolderWriteGate,
  type FolderProbeOutcome,
} from "./folder-write-check.js";

const fail = (code: string | null, message = "", step = "create"): Extract<FolderProbeOutcome, { ok: false }> => ({ ok: false, step, code, errno: null, message });

const winEnv = {
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  SystemRoot: "C:\\Windows",
  ProgramData: "C:\\ProgramData",
  OneDrive: "C:\\Users\\sam\\OneDrive",
};

afterEach(() => resetFolderWriteGate());

describe("classifyFailure", () => {
  test("POSIX codes", () => {
    expect(classifyFailure(fail("EACCES"), { platform: "linux", dir: "/srv/x" })).toBe("permission");
    expect(classifyFailure(fail("EPERM"), { platform: "linux", dir: "/srv/x" })).toBe("permission");
    expect(classifyFailure(fail("EROFS"), { platform: "linux", dir: "/mnt/ro" })).toBe("read_only_volume");
    expect(classifyFailure(fail("ENOSPC", "", "write"), { platform: "linux", dir: "/x" })).toBe("disk_full");
    expect(classifyFailure(fail("ENOENT"), { platform: "linux", dir: "/gone" })).toBe("missing");
    expect(classifyFailure(fail("EIO"), { platform: "linux", dir: "/x" })).toBe("unknown");
  });

  test("macOS privacy-protected folders and volumes", () => {
    const ctx = { platform: "darwin" as const, home: "/Users/sam" };
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "/Users/sam/Desktop/proj" })).toBe("macos_privacy");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "/Users/sam/Documents" })).toBe("macos_privacy");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "/Users/sam/Downloads/a" })).toBe("macos_privacy");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "/Volumes/USB/proj" })).toBe("macos_privacy");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "/Users/sam/code" })).toBe("permission");
    expect(classifyFailure(fail("EACCES"), { ...ctx, dir: "/Users/sam/Desktop" })).toBe("permission");
    expect(classifyFailure(fail("EROFS"), { ...ctx, dir: "/Volumes/dmg" })).toBe("read_only_volume");
  });

  test("Windows: Controlled folder access, system folders, read-only attribute, OneDrive, UNC", () => {
    const ctx = { platform: "win32" as const, env: winEnv };
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "C:\\Users\\sam\\Documents\\OmniRushTest", cfaOn: true })).toBe("protected_folder");
    expect(classifyFailure(fail("EACCES"), { ...ctx, dir: "C:\\Users\\sam\\Desktop\\x", cfaOn: true })).toBe("protected_folder");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "C:\\Program Files\\Thing" })).toBe("system_folder");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "c:\\windows\\system32" })).toBe("system_folder");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "C:\\" })).toBe("system_folder");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "D:\\proj", readOnlyMode: true })).toBe("read_only_attribute");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "D:\\proj" })).toBe("permission");
    expect(classifyFailure(fail("UNKNOWN", "UNKNOWN: unknown error, open"), { ...ctx, dir: "C:\\Users\\sam\\OneDrive\\proj" })).toBe("cloud_files");
    expect(classifyFailure(fail("UNKNOWN", "The cloud file provider is not running."), { ...ctx, dir: "D:\\sync\\proj" })).toBe("cloud_files");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "C:\\Users\\sam\\OneDrive\\proj" })).toBe("cloud_files");
    expect(classifyFailure(fail("EPERM"), { ...ctx, dir: "C:\\Users\\sam\\OneDrive\\proj", cfaOn: true })).toBe("protected_folder");
    expect(classifyFailure(fail("EACCES"), { ...ctx, dir: "\\\\nas\\share\\proj" })).toBe("network_folder");
    expect(classifyFailure(fail("EROFS"), { ...ctx, dir: "E:\\" })).toBe("read_only_volume");
    // Controlled folder access answers a create in a folder that is there with ENOENT (seen on Windows 11 26100).
    expect(classifyFailure(fail("ENOENT"), { ...ctx, dir: "C:\\Users\\sam\\Documents\\OmniRushTest", folderExists: true, cfaOn: true })).toBe("protected_folder");
    expect(classifyFailure(fail("ENOENT"), { ...ctx, dir: "C:\\Users\\sam\\Documents\\gone" })).toBe("missing");
    expect(classifyFailure(fail("EUNKNOWN"), { ...ctx, dir: "\\\\nohost\\share" })).toBe("network_folder");
  });
});

describe("controlledFolderAccessOn", () => {
  test("block mode only (1), not audit (2) or off (0)", async () => {
    const out = (value: string) => async () => `\r\n    EnableControlledFolderAccess    REG_DWORD    ${value}\r\n`;
    expect(await controlledFolderAccessOn(out("0x1"))).toBe(true);
    expect(await controlledFolderAccessOn(out("0x2"))).toBe(false);
    expect(await controlledFolderAccessOn(out("0x0"))).toBe(false);
    expect(await controlledFolderAccessOn(async () => { throw new Error("not found"); })).toBe(false);
  });
});

describe("checkFolderWritable", () => {
  test("a writable folder passes and leaves nothing behind", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fwc-"));
    try {
      expect(probeInProcess(dir)).toEqual({ ok: true });
      expect(await checkFolderWritable(dir, { engineBin: null })).toEqual({ ok: true, via: "server" });
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a read-only folder fails with permission and the fix", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "fwc-ro-"));
    chmodSync(dir, 0o555);
    try {
      const result = await checkFolderWritable(dir, { engineBin: null });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("permission");
      expect(result.code).toBe("EACCES");
      expect(result.message).toBe(`OmniRush can't write to ${dir}: permission denied (EACCES).`);
      expect(result.hint).toContain("chown");
    } finally {
      chmodSync(dir, 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("simulated Windows Controlled folder access names the engine to allow", async () => {
    const engine = "C:\\Program Files\\OmniRush\\resources\\sidecars\\opencode.exe";
    const result = await checkFolderWritable("C:\\Users\\sam\\Documents\\OmniRushTest", {
      platform: "win32",
      env: winEnv,
      engineBin: engine,
      probeEngine: async () => fail("ENOENT", "ENOENT: no such file or directory, open"),
      stat: () => ({ isDirectory: () => true, mode: 0o40777 }),
      cfa: async () => true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.via).toBe("engine");
    expect(result.reason).toBe("protected_folder");
    expect(result.message).toContain("Controlled folder access");
    expect(result.hint).toContain(engine);
  });

  test("simulated EROFS", async () => {
    const result = await checkFolderWritable("/mnt/ro", { platform: "linux", engineBin: "/x/opencode", probeEngine: async () => fail("EROFS") });
    expect(result.ok ? null : result.reason).toBe("read_only_volume");
  });

  test("the engine probe not running falls back to this process", async () => {
    let local = 0;
    const result = await checkFolderWritable("/x", { engineBin: "/x/opencode", probeEngine: async () => null, probeLocal: () => { local += 1; return { ok: true }; } });
    expect(result).toEqual({ ok: true, via: "server" });
    expect(local).toBe(1);
  });
});

describe("probeWithEngine", () => {
  test("runs bun in a private folder: a bunfig.toml or .env in the temporary folder (or anywhere) is never read", async () => {
    const shared = await mkdtemp(join(tmpdir(), "omnirush-shared-tmp-"));
    const target = await mkdtemp(join(tmpdir(), "omnirush-probe-target-"));
    const marker = join(shared, "marker");
    await writeFile(join(shared, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
    await writeFile(join(shared, ".env"), "PROBE_PLANTED=yes\n");
    await writeFile(join(shared, "evil.ts"), `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marker)}, "loaded " + (process.env.PROBE_PLANTED ?? "-") + "\\n");\n`);
    const previous = process.env.TMPDIR;
    try {
      // The planted folder works: bun started there without the probe's options runs it.
      const control = Bun.spawnSync([process.execPath, "-e", "0"], { cwd: shared, env: { ...process.env } });
      expect(control.exitCode).toBe(0);
      expect(await readFile(marker, "utf8")).toContain("loaded yes");
      await rm(marker, { force: true });
      // The probe, with the planted folder as the temporary folder: nothing of it is read.
      process.env.TMPDIR = shared;
      process.env.BUN_OPTIONS = `--preload=${join(shared, "evil.ts")}`;
      const outcome = await probeWithEngine(target, process.execPath);
      expect(outcome).toEqual({ ok: true });
      expect(await readFile(marker, "utf8").catch(() => "")).toBe("");
      // Its private folder is gone afterwards.
      expect((await readdir(shared)).filter((name) => name.startsWith("probe-"))).toEqual([]);
      // Under the app's user data folder when the desktop names one.
      const userData = await mkdtemp(join(tmpdir(), "omnirush-user-data-"));
      process.env.OMNIRUSH_DESKTOP_USER_DATA_DIR = userData;
      try {
        expect(await probeWithEngine(target, process.execPath)).toEqual({ ok: true });
        expect(await readFile(marker, "utf8").catch(() => "")).toBe("");
        expect(await readdir(join(userData, "write-check"))).toEqual([]);
        expect((await stat(join(userData, "write-check"))).mode & 0o777).toBe(0o700);
      } finally {
        delete process.env.OMNIRUSH_DESKTOP_USER_DATA_DIR;
        await rm(userData, { recursive: true, force: true });
      }
    } finally {
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
      delete process.env.BUN_OPTIONS;
      await rm(shared, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  test("names an empty bunfig of its own folder and no .env file", () => {
    expect(isolatedBunArgs("/private/x")).toEqual(["--no-env-file", `--config=${join("/private/x", "bunfig.toml")}`]);
  });
});

describe("folderWriteGate", () => {
  test("once per chat and folder after a pass; again at every prompt after a failure", async () => {
    let probes = 0;
    let ok = false;
    const options = { engineBin: "/x/opencode", probeEngine: async (): Promise<FolderProbeOutcome> => { probes += 1; return ok ? { ok: true } : fail("EACCES"); }, platform: "linux" as const };
    expect((await folderWriteGate("ses_1", "/p", options))?.reason).toBe("permission");
    expect((await folderWriteGate("ses_1", "/p", options))?.reason).toBe("permission");
    expect(probes).toBe(2);
    ok = true;
    expect(await folderWriteGate("ses_1", "/p", options)).toBeNull();
    expect(await folderWriteGate("ses_1", "/p", options)).toBeNull();
    expect(probes).toBe(3);
    // Another folder for the same chat is checked.
    expect(await folderWriteGate("ses_1", "/q", options)).toBeNull();
    expect(probes).toBe(4);
  });

  test("OMNIRUSH_WRITE_CHECK=off skips it", async () => {
    expect(await folderWriteGate("ses_2", "/p", { env: { OMNIRUSH_WRITE_CHECK: "off" }, probeEngine: async () => fail("EACCES"), engineBin: "/x" })).toBeNull();
  });

  test("plan-agent prompts are read-only", () => {
    expect(readOnlyPrompt({ agent: "plan", parts: [] })).toBe(true);
    expect(readOnlyPrompt({ agent: "build" })).toBe(false);
    expect(readOnlyPrompt({})).toBe(false);
    expect(readOnlyPrompt(null)).toBe(false);
  });
});
