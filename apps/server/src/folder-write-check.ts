/**
 * Write check of a project folder, before the agent's first turn there.
 *
 * A folder the engine cannot write to (Windows Controlled folder access, a
 * OneDrive folder whose files are online-only, a read-only drive or mount, a
 * system folder, a macOS privacy-protected folder) let the agent run whole
 * turns, spending tokens, without changing a file. This check creates,
 * writes, fsyncs, renames and deletes a temporary file in the folder, run by
 * the engine binary itself (BUN_BE_BUN=1: the same executable, so the same
 * Defender and macOS privacy decisions as the engine's own writes), and
 * names the reason and the fix when it fails.
 *
 * Kept in step with the CLI (omnirush-cli src/folder-write-check.js).
 */
import { execFile, spawn } from "node:child_process";
import { chmodSync, closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type FolderWriteReason =
  | "missing"
  | "not_a_folder"
  | "read_only_volume"
  | "read_only_attribute"
  | "permission"
  | "protected_folder"
  | "cloud_files"
  | "system_folder"
  | "network_folder"
  | "macos_privacy"
  | "disk_full"
  | "unknown";

export type FolderProbeOutcome =
  | { ok: true }
  | { ok: false; step: string; code: string | null; errno: number | null; message: string };

export type FolderWriteResult =
  | { ok: true; via: "engine" | "server" | "skipped" }
  | {
      ok: false;
      via: "engine" | "server";
      reason: FolderWriteReason;
      code: string | null;
      step: string;
      /** "OmniRush can't write to <folder>: <why>." */
      message: string;
      /** How to fix it, for this platform. */
      hint: string;
    };

export const FOLDER_NOT_WRITABLE = "workspace_not_writable";

/**
 * The probe the engine binary runs (`BUN_BE_BUN=1 <engine> -e <script>`).
 * Prints one JSON line; never throws.
 */
export const PROBE_SCRIPT = [
  'const fs=require("node:fs"),p=require("node:path");',
  "const d=process.env.OMNIRUSH_WRITE_CHECK_DIR;",
  'const n=".omnirush-write-check-"+process.pid+"-"+Date.now().toString(36);',
  'const a=p.join(d,n+".tmp"),b=p.join(d,n);let step="create",fd;',
  'try{fd=fs.openSync(a,"wx");step="write";fs.writeSync(fd,"omnirush write check\\n");step="fsync";fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;',
  'step="rename";fs.renameSync(a,b);step="delete";fs.unlinkSync(b);process.stdout.write(JSON.stringify({ok:true}))}',
  "catch(e){if(fd!==undefined)try{fs.closeSync(fd)}catch{}for(const f of[a,b])try{fs.unlinkSync(f)}catch{}",
  "process.stdout.write(JSON.stringify({ok:false,step,code:e&&e.code||null,errno:e&&typeof e.errno===\"number\"?e.errno:null,message:String(e&&e.message||e).slice(0,300)}))}",
].join("");

/** The same steps in this process (no engine binary, or it could not run). */
export function probeInProcess(dir: string): FolderProbeOutcome {
  const name = `.omnirush-write-check-${process.pid}-${Date.now().toString(36)}`;
  const a = path.join(dir, `${name}.tmp`);
  const b = path.join(dir, name);
  let step = "create";
  let fd: number | undefined;
  try {
    fd = openSync(a, "wx");
    step = "write";
    writeSync(fd, "omnirush write check\n");
    step = "fsync";
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    step = "rename";
    renameSync(a, b);
    step = "delete";
    unlinkSync(b);
    return { ok: true };
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ }
    for (const file of [a, b]) try { unlinkSync(file); } catch { /* not there */ }
    const e = error as NodeJS.ErrnoException;
    return { ok: false, step, code: e?.code ?? null, errno: typeof e?.errno === "number" ? e.errno : null, message: String(e?.message ?? e).slice(0, 300) };
  }
}

/**
 * The engine binary run as bun reads a bunfig.toml (its `preload` runs code)
 * and a .env from its working folder. The probe runs in a fresh private
 * folder of its own (under the app's user data folder, else the temporary
 * folder; 0700), with an empty bunfig the app writes there named on the
 * command line and no .env file, so no other folder (a shared temporary
 * folder, a project) adds anything to it. The same options as the CLI's
 * helper runtime.
 */
export function isolatedBunArgs(folder: string): string[] {
  return ["--no-env-file", `--config=${path.join(folder, "bunfig.toml")}`];
}

function isolatedBunFolder(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const userData = env.OMNIRUSH_DESKTOP_USER_DATA_DIR?.trim();
    const parent = userData ? path.join(userData, "write-check") : os.tmpdir();
    if (userData) mkdirSync(parent, { recursive: true, mode: 0o700 });
    const folder = mkdtempSync(path.join(parent, "probe-"));
    chmodSync(folder, 0o700);
    writeFileSync(path.join(folder, "bunfig.toml"), "", { mode: 0o600 });
    return folder;
  } catch {
    return null;
  }
}

/** The probe run by the engine binary; null when it could not run or said nothing usable. */
export function probeWithEngine(dir: string, engineBin: string, timeoutMs = 15_000): Promise<FolderProbeOutcome | null> {
  const folder = isolatedBunFolder();
  if (!folder) return Promise.resolve(null);
  return probeIn(folder, dir, engineBin, timeoutMs).finally(() => {
    try { rmSync(folder, { recursive: true, force: true }); } catch { /* best effort */ }
  });
}

function probeIn(folder: string, dir: string, engineBin: string, timeoutMs: number): Promise<FolderProbeOutcome | null> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (value: FolderProbeOutcome | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, BUN_BE_BUN: "1", OMNIRUSH_WRITE_CHECK_DIR: dir };
      // Extra command-line options bun would take from the environment.
      delete env.BUN_OPTIONS;
      child = spawn(engineBin, [...isolatedBunArgs(folder), "-e", PROBE_SCRIPT], {
        cwd: folder,
        env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      finish(null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", () => finish(null));
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out.trim().split("\n").pop() ?? "");
        if (parsed && typeof parsed.ok === "boolean") return finish(parsed as FolderProbeOutcome);
      } catch { /* not JSON */ }
      finish(null);
    });
  });
}

/** Whether Windows Security's Controlled folder access is on (block mode). */
export function controlledFolderAccessOn(run: (args: string[]) => Promise<string> = regQuery): Promise<boolean> {
  const keys = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows Defender\\Windows Defender Exploit Guard\\Controlled Folder Access",
    "HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender\\Windows Defender Exploit Guard\\Controlled Folder Access",
  ];
  return Promise.all(keys.map((key) => run(["query", key, "/v", "EnableControlledFolderAccess"]).catch(() => "")))
    .then((outs) => outs.some((text) => /EnableControlledFolderAccess\s+REG_DWORD\s+0x0*1\b/i.test(text)));
}

function regQuery(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("reg", args, { timeout: 3_000, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  });
}

export type ClassifyContext = {
  platform: NodeJS.Platform;
  dir: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Windows: Controlled folder access is on. */
  cfaOn?: boolean;
  /** The folder's mode lacks the owner write bit (Windows: the read-only attribute). */
  readOnlyMode?: boolean;
  /** The folder is there (a create that fails with ENOENT is then not a missing folder). */
  folderExists?: boolean;
  /** The executable to allow (Controlled folder access). */
  engineBin?: string | null;
};

function under(child: string, parent: string | undefined, win: boolean): boolean {
  if (!parent) return false;
  const norm = (value: string) => {
    const resolved = (win ? path.win32 : path.posix).resolve(value);
    return win ? resolved.toLowerCase() : resolved;
  };
  const c = norm(child);
  const p = norm(parent);
  const sep = win ? "\\" : "/";
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

const CLOUD_TEXT = /cloud (?:file|operation|provider)|0x8007016a|0x80070185|0x8007018[0-9a-f]/i;

/** The reason a failed probe names. */
export function classifyFailure(outcome: Extract<FolderProbeOutcome, { ok: false }>, ctx: ClassifyContext): FolderWriteReason {
  const env = ctx.env ?? {};
  const code = outcome.code ?? "";
  const win = ctx.platform === "win32";
  if (code === "ENOENT" && outcome.step === "create" && !ctx.folderExists) return "missing";
  if (code === "ENOTDIR") return "not_a_folder";
  if (code === "ENOSPC" || code === "EDQUOT") return "disk_full";
  if (code === "EROFS") return "read_only_volume";
  if (win) {
    if (/^\\\\/.test(ctx.dir) || /^\/\//.test(ctx.dir)) return "network_folder";
    const oneDrive = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].some((root) => under(ctx.dir, root, true));
    if (CLOUD_TEXT.test(outcome.message) || (oneDrive && !["EPERM", "EACCES"].includes(code) )) return "cloud_files";
    // Controlled folder access refuses a create with ERROR_FILE_NOT_FOUND (ENOENT) in a folder that is there.
    if (code === "EPERM" || code === "EACCES" || (code === "ENOENT" && ctx.folderExists)) {
      const parsed = path.win32.parse(path.win32.resolve(ctx.dir));
      const system = [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432, env.SystemRoot, env.windir, env.ProgramData]
        .some((root) => under(ctx.dir, root, true));
      if (system || parsed.root.toLowerCase() === path.win32.resolve(ctx.dir).toLowerCase()) return "system_folder";
      if (ctx.cfaOn) return "protected_folder";
      if (ctx.readOnlyMode) return "read_only_attribute";
      if (oneDrive) return "cloud_files";
      return "permission";
    }
    return oneDrive ? "cloud_files" : "unknown";
  }
  if (ctx.platform === "darwin" && code === "EPERM") {
    const home = ctx.home ?? os.homedir();
    const tcc = ["Desktop", "Documents", "Downloads", "Library/Mobile Documents", "Library/CloudStorage"].map((name) => path.posix.join(home, name));
    if (tcc.some((root) => under(ctx.dir, root, false)) || under(ctx.dir, "/Volumes", false)) return "macos_privacy";
  }
  if (code === "EACCES" || code === "EPERM") return "permission";
  return "unknown";
}

const WHY: Record<FolderWriteReason, string> = {
  missing: "the folder does not exist any more",
  not_a_folder: "it is not a folder",
  read_only_volume: "the drive or mount is read-only",
  read_only_attribute: "the folder is marked read-only",
  permission: "permission denied",
  protected_folder: "Windows Security's Controlled folder access blocks the change",
  cloud_files: "it is a OneDrive folder whose files are not available on this device",
  system_folder: "it is a system folder that needs administrator rights",
  network_folder: "the network folder refused the write or cannot be reached",
  macos_privacy: "macOS privacy settings do not allow OmniRush to change files there",
  disk_full: "the disk is full",
  unknown: "a test file could not be written",
};

/** How to fix it, for this platform. */
export function fixHint(reason: FolderWriteReason, platform: NodeJS.Platform, engineBin?: string | null): string {
  const elsewhere = (where: string) => `Or choose another folder ${where}.`;
  const other = "Or choose another folder.";
  switch (reason) {
    case "missing":
    case "not_a_folder":
      return "Choose another folder.";
    case "read_only_volume":
      return platform === "darwin"
        ? `The volume is mounted read-only (a disk image, a locked card, a read-only share). Copy the project into your home folder. ${other}`
        : platform === "win32"
          ? `Copy the project to a folder on a writable drive (for example C:\\Users\\<you>\\Projects). ${other}`
          : `Remount it read-write (for example: sudo mount -o remount,rw <mount point>), or copy the project into your home folder. ${other}`;
    case "read_only_attribute":
      return `Open the folder's Properties, clear "Read-only" and apply it to all files and subfolders. ${other}`;
    case "permission":
      return platform === "win32"
        ? `Check the folder's Properties → Security permissions for your account, or use a folder under C:\\Users\\<you>. If Controlled folder access is on, allow OmniRush in Windows Security. ${other}`
        : `Make your user the owner (for example: sudo chown -R "$USER" <folder>) or give it write permission (chmod -R u+w <folder>). ${other}`;
    case "protected_folder":
      return `Open Windows Security → Virus & threat protection → Ransomware protection → Allow an app through Controlled folder access, and add ${engineBin ? `"${engineBin}"` : "OmniRush's engine"}. ${elsewhere("outside Documents, Desktop, Pictures, Music and Videos")}`;
    case "cloud_files":
      return `Make sure OneDrive is running and signed in, then right-click the folder → "Always keep on this device". ${elsewhere("on this device, outside OneDrive (for example C:\\Users\\<you>\\Projects)")}`;
    case "system_folder":
      return "Choose a folder in your user folder, for example C:\\Users\\<you>\\Projects. Running OmniRush as administrator is not needed.";
    case "network_folder":
      return `Check the network connection and your write access to the share, or copy the project to a local folder. ${other}`;
    case "macos_privacy":
      return `Open System Settings → Privacy & Security → Files and Folders (or Full Disk Access) and allow OmniRush, then try again. ${elsewhere("outside Desktop, Documents and Downloads")}`;
    case "disk_full":
      return `Free some disk space, then try again. ${other}`;
    default:
      return `Check that you can create files there, then try again. ${other}`;
  }
}

export type CheckOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  engineBin?: string | null;
  probeEngine?: typeof probeWithEngine;
  probeLocal?: typeof probeInProcess;
  cfa?: () => Promise<boolean>;
  stat?: (dir: string) => { isDirectory(): boolean; mode: number };
};

/** Run the write check on a folder. Fails open (ok) only when no probe could run at all. */
export async function checkFolderWritable(folder: string, options: CheckOptions = {}): Promise<FolderWriteResult> {
  // The engine probe runs elsewhere (cwd: the temp folder): the folder goes to it absolute.
  const platform = options.platform ?? process.platform;
  const dir = (platform === "win32" ? path.win32 : path.posix).resolve(folder);
  const env = options.env ?? process.env;
  const engineBin = options.engineBin?.trim() || null;
  let outcome: FolderProbeOutcome | null = null;
  let via: "engine" | "server" = "engine";
  if (engineBin) outcome = await (options.probeEngine ?? probeWithEngine)(dir, engineBin);
  if (!outcome) {
    via = "server";
    outcome = (options.probeLocal ?? probeInProcess)(dir);
  }
  if (outcome.ok) return { ok: true, via };
  let readOnlyMode = false;
  let folderExists = false;
  try {
    const info = (options.stat ?? statSync)(dir);
    if (!info.isDirectory()) outcome = { ...outcome, code: "ENOTDIR" };
    folderExists = info.isDirectory();
    readOnlyMode = (info.mode & 0o200) === 0;
  } catch { /* classified from the probe */ }
  const code = outcome.code ?? "";
  const cfaOn = platform === "win32" && (code === "EPERM" || code === "EACCES" || (code === "ENOENT" && folderExists))
    ? await (options.cfa ?? (() => controlledFolderAccessOn()))().catch(() => false)
    : false;
  const reason = classifyFailure(outcome, { platform, dir, env, cfaOn, readOnlyMode, folderExists, engineBin });
  const codeText = outcome.code ? ` (${outcome.code})` : "";
  return {
    ok: false,
    via,
    reason,
    code: outcome.code,
    step: outcome.step,
    message: `OmniRush can't write to ${dir}: ${WHY[reason]}${codeText}.`,
    hint: fixHint(reason, platform, engineBin),
  };
}

// --- the gate: once per chat and folder, before its first turn ---------------------

let engineBinary: string | null = null;
/** The engine binary the server starts (embedded.ts); the probe runs it. */
export function setWriteCheckEngine(bin: string | null | undefined): void {
  engineBinary = bin?.trim() || null;
}

const SUCCESS_TTL_MS = 60_000;
const checkedChats = new Set<string>();
const recentOk = new Map<string, number>();
const inFlight = new Map<string, Promise<FolderWriteResult>>();

export function writeCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:0|off|false|no)$/i.test((env.OMNIRUSH_WRITE_CHECK ?? "").trim());
}

/** A prompt for the read-only plan agent edits nothing: it is never held back. */
export function readOnlyPrompt(body: unknown): boolean {
  return Boolean(body && typeof body === "object" && (body as { agent?: unknown }).agent === "plan");
}

/**
 * The check for a chat's prompt in a folder: null to go on, else the failed
 * result. A chat that passed in a folder is not checked again there; a failed
 * folder is checked again at every prompt (the person fixed it, or not).
 */
export async function folderWriteGate(sessionId: string, dir: string, options: CheckOptions & { now?: () => number } = {}): Promise<Extract<FolderWriteResult, { ok: false }> | null> {
  if (writeCheckDisabled(options.env)) return null;
  const key = `${sessionId}\0${dir}`;
  if (checkedChats.has(key)) return null;
  const now = (options.now ?? Date.now)();
  const recent = recentOk.get(dir);
  if (recent !== undefined && now - recent < SUCCESS_TTL_MS) {
    checkedChats.add(key);
    return null;
  }
  let pending = inFlight.get(dir);
  if (!pending) {
    pending = checkFolderWritable(dir, { engineBin: engineBinary ?? process.env.OMNIRUSH_OPENCODE_BIN ?? null, ...options })
      .finally(() => inFlight.delete(dir));
    inFlight.set(dir, pending);
  }
  const result = await pending;
  if (result.ok) {
    if (checkedChats.size >= 10_000) checkedChats.clear();
    recentOk.set(dir, now);
    checkedChats.add(key);
    return null;
  }
  recentOk.delete(dir);
  return result;
}

export function resetFolderWriteGate(): void {
  checkedChats.clear();
  recentOk.clear();
  inFlight.clear();
}
