/**
 * The desktop editor's routes (the code editor beside the chat): the project
 * file list (git's view of it, so .gitignore'd files stay out), reading and
 * saving any text file, and a small git panel (status, stage, unstage,
 * commit, the HEAD/index text of a file for its diff).
 *
 * Nothing here runs unless the editor asks. A save that names a chat the
 * session uploader is tracking reports a "user_edit" (and a hunk review
 * decision a "user_review") through `onUserEdit` / `onUserReview`; a save
 * without one, or for a chat that is not tracked, reports nothing.
 */
import { gitChildEnv } from "../git-env.js";
import { spawn } from "node:child_process";
import { readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { ApiError } from "../errors.js";
import { ignoredByRules, parseGitignoreRules, scopedIgnoreRules } from "../session-uploader.js";
import type { ApprovalRequest, ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { ensureDir } from "../utils.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

/** The largest file the editor opens or saves. */
export const EDITOR_MAX_FILE_BYTES = 5_000_000;
/** The most files the tree lists; a larger project says it was cut. */
export const EDITOR_MAX_TREE_FILES = 200_000;
const GIT_TIMEOUT_MS = 20_000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const WALK_SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".cache", ".next", ".turbo", ".gradle", ".npm", ".pnpm-store"]);
/** A folder that is not a repository is walked for at most this long (a home folder can hold millions of files). */
const WALK_TIME_LIMIT_MS = 8_000;
const COMMIT_MESSAGE_MAX = 20_000;
const MAX_PATHS_PER_CALL = 5_000;

export type EditorUserEdit = {
  workspace: WorkspaceInfo;
  sessionId: string;
  path: string;
  before: string | null;
  after: string | null;
  source: "editor" | "review";
};

export type EditorUserReview = {
  workspace: WorkspaceInfo;
  sessionId: string;
  path: string;
  decision: "accept" | "reject";
  added: number;
  removed: number;
  scope: "hunk" | "file";
};

type RegisterEditorRoutesOptions = {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireApproval: (ctx: RequestContext, input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">) => Promise<void>;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  onUserEdit?: (edit: EditorUserEdit) => void;
  onUserReview?: (review: EditorUserReview) => void;
  /** Every save or delete the editor made, with or without a chat (editor-saves.ts). */
  onSaved?: (workspace: WorkspaceInfo, path: string) => void;
};

type GitResult = { code: number | null; stdout: Buffer; stderr: string };

export function runEditorGit(root: string, args: string[], options: { input?: string; timeoutMs?: number } = {}): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    let child;
    try {
      // No inherited GIT_* settings (a GIT_DIR or GIT_WORK_TREE from the app's own environment
      // would point git elsewhere); paths are literal, never globs; no fsmonitor program.
      // The commit's hooks are the repository's code: only the filtered environment (git-env.ts), no app tokens.
      child = spawn("git", ["-c", "core.quotePath=false", "-c", "color.ui=false", "-c", "core.fsmonitor=false", ...args], {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
        env: gitChildEnv({ GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C" }),
        windowsHide: true,
      });
    } catch (error) {
      resolvePromise({ code: null, stdout: Buffer.alloc(0), stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let settled = false;
    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout: Buffer.concat(chunks), stderr: "git timed out" });
    }, options.timeoutMs ?? GIT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > GIT_MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish({ code: null, stdout: Buffer.concat(chunks), stderr: "git output too large" });
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish({ code: null, stdout: Buffer.alloc(0), stderr: error.message }));
    child.on("close", (code) => finish({ code, stdout: Buffer.concat(chunks), stderr }));
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input ?? "");
  });
}

function splitNul(buffer: Buffer): string[] {
  return buffer.toString("utf8").split("\0").filter((item) => item.length > 0);
}

/** The workspace-relative path, checked (no `..`, no absolute paths, no reserved names). */
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function isGitComponent(part: string): boolean {
  return part.toLowerCase() === ".git";
}

/**
 * The workspace-relative path, checked strictly and never rewritten: no
 * absolute paths, no `..`, no NUL, no `.git` folder at any depth (any case).
 */
export function editorPath(input: unknown): string {
  const raw = String(input ?? "").replace(/\\/g, "/");
  const invalid = (message: string) => new ApiError(400, "invalid_path", message);
  if (!raw.trim()) throw invalid("A path is required");
  if (raw.includes("\0")) throw invalid("Invalid path");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw invalid("Path must be relative to the workspace");
  const parts = raw.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0) throw invalid("A path is required");
  if (parts.some((part) => part === "..")) throw invalid("Path traversal is not allowed");
  if (parts.some(isGitComponent)) throw invalid("The .git folder is not editable");
  if (process.platform === "win32" && parts.some((part) => part.includes(":") || WINDOWS_RESERVED_NAME.test(part) || /[. ]$/.test(part))) {
    throw invalid("This name is not valid on Windows");
  }
  return parts.join("/");
}

/** The file's absolute path inside the workspace; a symlinked folder that leads out of it is refused. */
async function resolveInside(root: string, relativePath: string): Promise<string> {
  const rootResolved = resolve(root);
  const candidate = resolve(rootResolved, relativePath);
  if (candidate === rootResolved || !candidate.startsWith(rootResolved + sep)) {
    throw new ApiError(400, "invalid_path", "Path must point inside the workspace");
  }
  const rootReal = await realpath(rootResolved).catch(() => rootResolved);
  // The nearest existing ancestor must stay inside the workspace once symlinks are followed.
  let probe = candidate;
  for (;;) {
    const real = await realpath(probe).catch(() => null);
    if (real !== null) {
      if (real !== rootReal && !real.startsWith(rootReal + sep)) {
        throw new ApiError(400, "invalid_path", "Path leads outside the workspace");
      }
      // A symlink into a .git folder is refused like the folder itself.
      if (relative(rootReal, real).split(sep).some(isGitComponent)) {
        throw new ApiError(400, "invalid_path", "The .git folder is not editable");
      }
      break;
    }
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return candidate;
}

function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, 8000);
  for (let i = 0; i < end; i += 1) if (buffer[i] === 0) return true;
  return false;
}

function sessionIdOf(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(value) ? value : null;
}

function pathsOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new ApiError(400, "invalid_payload", "paths must be a non-empty array");
  if (value.length > MAX_PATHS_PER_CALL) throw new ApiError(400, "invalid_payload", "Too many paths");
  return value.map((item) => editorPath(item));
}

async function isGitWorkTree(root: string): Promise<boolean> {
  const result = await runEditorGit(root, ["rev-parse", "--is-inside-work-tree"], { timeoutMs: 5_000 });
  return result.code === 0 && result.stdout.toString("utf8").trim() === "true";
}

/** The project's files as git sees them: tracked and untracked, .gitignore'd ones left out. */
async function gitTree(root: string): Promise<string[] | null> {
  const listed = await runEditorGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--deduplicate"]);
  if (listed.code !== 0) return null;
  const deleted = await runEditorGit(root, ["ls-files", "-z", "--deleted"]);
  const gone = new Set(deleted.code === 0 ? splitNul(deleted.stdout) : []);
  return splitNul(listed.stdout).filter((path) => !gone.has(path));
}

/** Without git: a walk that skips .git and node_modules and applies the .gitignore files it meets. */
async function walkTree(root: string, limit: number): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  const deadline = Date.now() + WALK_TIME_LIMIT_MS;
  const walk = async (dir: string, rules: string[]) => {
    if (truncated) return;
    if (Date.now() > deadline) {
      truncated = true;
      return;
    }
    const rel = relative(root, dir).replace(/\\/g, "/");
    const local = await readFile(join(dir, ".gitignore"), "utf8").then(parseGitignoreRules).catch(() => [] as string[]);
    const scoped = [...rules, ...scopedIgnoreRules(rel, local)];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (WALK_SKIPPED_DIRECTORIES.has(entry.name) || isGitComponent(entry.name) || ignoredByRules(`${path}/`, scoped)) continue;
        await walk(join(dir, entry.name), scoped);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (ignoredByRules(path, scoped)) continue;
        if (files.length >= limit) {
          truncated = true;
          return;
        }
        files.push(path);
      }
    }
  };
  await walk(root, []);
  return { files, truncated };
}

export type EditorGitFile = {
  path: string;
  /** The rename's source path. */
  from?: string;
  /** Porcelain v1 letters: X (index) and Y (work tree), "?" for untracked. */
  index: string;
  worktree: string;
};

export type EditorGitStatus = {
  repo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: EditorGitFile[];
};

/** `git status --porcelain=v1 -z -b` as data. */
export function parsePorcelainStatus(output: string): Omit<EditorGitStatus, "repo"> {
  const entries = output.split("\0");
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: EditorGitFile[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (!entry) continue;
    if (entry.startsWith("## ")) {
      const head = entry.slice(3);
      const tracking = /^(.*?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head);
      const name = tracking?.[1] ?? head;
      branch = name.startsWith("No commits yet on ") ? name.slice("No commits yet on ".length)
        : name.startsWith("HEAD (no branch)") ? null
          : name;
      upstream = tracking?.[2] ?? null;
      const counts = tracking?.[3] ?? "";
      ahead = Number(/ahead (\d+)/.exec(counts)?.[1] ?? 0);
      behind = Number(/behind (\d+)/.exec(counts)?.[1] ?? 0);
      continue;
    }
    const index = entry[0] ?? " ";
    const worktree = entry[1] ?? " ";
    const path = entry.slice(3);
    if (index === "R" || index === "C") {
      const from = entries[i + 1] ?? "";
      i += 1;
      files.push({ path, from, index, worktree });
    } else {
      files.push({ path, index, worktree });
    }
  }
  return { branch, upstream, ahead, behind, files };
}

async function gitStatus(root: string): Promise<EditorGitStatus> {
  if (!(await isGitWorkTree(root))) return { repo: false, branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  // Paths relative to the workspace folder (which may sit inside a larger repository).
  const result = await runEditorGit(root, ["status", "--porcelain=v1", "-z", "-b", "--untracked-files=all", "--", "."]);
  if (result.code !== 0) throw new ApiError(500, "git_failed", result.stderr.trim() || "git status failed");
  const prefix = (await runEditorGit(root, ["rev-parse", "--show-prefix"], { timeoutMs: 5_000 })).stdout.toString("utf8").trim();
  const parsed = parsePorcelainStatus(result.stdout.toString("utf8"));
  const strip = (path: string) => (prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path);
  return {
    repo: true,
    ...parsed,
    files: parsed.files
      .filter((file) => !prefix || file.path.startsWith(prefix))
      .map((file) => ({ ...file, path: strip(file.path), ...(file.from ? { from: strip(file.from) } : {}) }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function registerEditorRoutes(options: RegisterEditorRoutesOptions): void {
  const { routes, config, jsonResponse, readJsonBody, ensureWritable, requireApproval, requireClientScope, resolveWorkspace } = options;

  addRoute(routes, "GET", "/workspace/:id/editor/tree", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const root = resolve(workspace.path);
    const info = await stat(root).catch(() => null);
    if (!info?.isDirectory()) throw new ApiError(404, "workspace_not_found", "The workspace folder no longer exists.");
    const git = await isGitWorkTree(root);
    const listed = git ? await gitTree(root) : null;
    let files: string[];
    let truncated = false;
    if (listed) {
      files = listed.slice(0, EDITOR_MAX_TREE_FILES);
      truncated = listed.length > files.length;
    } else {
      ({ files, truncated } = await walkTree(root, EDITOR_MAX_TREE_FILES));
    }
    files.sort((a, b) => a.localeCompare(b));
    return jsonResponse({ git: Boolean(listed), files, truncated, generatedAt: Date.now() });
  });

  addRoute(routes, "GET", "/workspace/:id/editor/file", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const path = editorPath(ctx.url.searchParams.get("path"));
    const absolute = await resolveInside(workspace.path, path);
    const info = await stat(absolute).catch(() => null);
    if (!info?.isFile()) throw new ApiError(404, "file_not_found", "File not found");
    if (info.size > EDITOR_MAX_FILE_BYTES) {
      return jsonResponse({ path, content: null, tooLarge: true, bytes: info.size, maxBytes: EDITOR_MAX_FILE_BYTES, updatedAt: info.mtimeMs });
    }
    const buffer = await readFile(absolute);
    if (looksBinary(buffer)) return jsonResponse({ path, content: null, binary: true, bytes: info.size, updatedAt: info.mtimeMs });
    return jsonResponse({ path, content: buffer.toString("utf8"), bytes: info.size, updatedAt: info.mtimeMs });
  });

  addRoute(routes, "PUT", "/workspace/:id/editor/file", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    // JSON-escaped text can be up to 6 bytes per byte; anything larger is refused before it is read.
    const declared = Number(ctx.request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > EDITOR_MAX_FILE_BYTES * 6 + 64 * 1024) {
      throw new ApiError(413, "file_too_large", "File exceeds size limit", { maxBytes: EDITOR_MAX_FILE_BYTES });
    }
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const path = editorPath(body.path);
    const remove = body.delete === true;
    if (!remove && typeof body.content !== "string") throw new ApiError(400, "invalid_payload", "content must be a string");
    const content = remove ? "" : (body.content as string);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > EDITOR_MAX_FILE_BYTES) throw new ApiError(413, "file_too_large", "File exceeds size limit", { maxBytes: EDITOR_MAX_FILE_BYTES, size: bytes });
    const baseUpdatedAt = typeof body.baseUpdatedAt === "number" && Number.isFinite(body.baseUpdatedAt) ? body.baseUpdatedAt : null;
    const absolute = await resolveInside(workspace.path, path);
    const current = await stat(absolute).catch(() => null);
    if (current && !current.isFile()) throw new ApiError(400, "invalid_path", "Path must point to a file");
    if (body.force !== true && current && baseUpdatedAt !== null && current.mtimeMs !== baseUpdatedAt) {
      throw new ApiError(409, "conflict", "File changed on disk since it was opened", { baseUpdatedAt, currentUpdatedAt: current.mtimeMs });
    }
    const sessionId = sessionIdOf(body.sessionId);
    // The text before the save, only when a tracked chat may want the change.
    let before: string | null = null;
    if (sessionId && options.onUserEdit && current && current.size <= EDITOR_MAX_FILE_BYTES) {
      const buffer = await readFile(absolute).catch(() => null);
      before = buffer && !looksBinary(buffer) ? buffer.toString("utf8") : null;
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "workspace.file.write",
      summary: remove ? `Delete ${path}` : `Write ${path}`,
      paths: [absolute],
    });
    if (remove) {
      await rm(absolute, { force: true });
    } else {
      // In place: no temporary file appears in the project (the session uploader watches it),
      // and the file keeps its mode, hard links and symlink.
      await ensureDir(dirname(absolute));
      await writeFile(absolute, content, "utf8");
    }
    const after = remove ? null : await stat(absolute);
    try {
      options.onSaved?.(workspace, path);
    } catch {
      // Remembering a save never fails it.
    }
    // A file whose old text could not be read (binary, too large) is not reported.
    if (sessionId && options.onUserEdit && (!current || before !== null)) {
      const source = body.source === "review" ? "review" : "editor";
      try {
        options.onUserEdit({ workspace, sessionId, path, before, after: remove ? null : content, source });
      } catch {
        // Reporting never fails a save.
      }
    }
    return jsonResponse({ ok: true, path, bytes, deleted: remove, updatedAt: after?.mtimeMs ?? null });
  });

  addRoute(routes, "POST", "/workspace/:id/editor/review", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const sessionId = sessionIdOf(body.sessionId);
    const path = editorPath(body.path);
    const decision = body.decision === "accept" ? "accept" : body.decision === "reject" ? "reject" : null;
    if (!sessionId || !decision) throw new ApiError(400, "invalid_payload", "sessionId and decision are required");
    const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);
    try {
      options.onUserReview?.({ workspace, sessionId, path, decision, added: count(body.added), removed: count(body.removed), scope: body.scope === "file" ? "file" : "hunk" });
    } catch {
      // Reporting never fails the review.
    }
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/workspace/:id/editor/git/status", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse(await gitStatus(resolve(workspace.path)));
  });

  addRoute(routes, "GET", "/workspace/:id/editor/git/original", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const path = editorPath(ctx.url.searchParams.get("path"));
    const ref = ctx.url.searchParams.get("ref") === "index" ? "index" : "HEAD";
    const root = resolve(workspace.path);
    // `./path` keeps the pathspec relative to the workspace folder inside a larger repository.
    const spec = ref === "index" ? `:./${path}` : `HEAD:./${path}`;
    const result = await runEditorGit(root, ["show", spec]);
    if (result.code !== 0) return jsonResponse({ path, ref, content: null, exists: false });
    if (result.stdout.length > EDITOR_MAX_FILE_BYTES) return jsonResponse({ path, ref, content: null, exists: true, tooLarge: true });
    if (looksBinary(result.stdout)) return jsonResponse({ path, ref, content: null, exists: true, binary: true });
    return jsonResponse({ path, ref, content: result.stdout.toString("utf8"), exists: true });
  });

  const gitWrite = async (ctx: RequestContext, summary: string) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const root = resolve(workspace.path);
    if (!(await isGitWorkTree(root))) throw new ApiError(400, "not_a_repository", "This folder is not a git repository");
    await requireApproval(ctx, { workspaceId: workspace.id, action: "workspace.git", summary, paths: [root] });
    return root;
  };
  const gitFailure = (result: GitResult, fallback: string) =>
    new ApiError(400, "git_failed", (result.stderr || result.stdout.toString("utf8")).trim().slice(0, 2_000) || fallback);

  addRoute(routes, "POST", "/workspace/:id/editor/git/stage", "client", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const paths = pathsOf(body.paths);
    const root = await gitWrite(ctx, `Stage ${paths.length} file(s)`);
    const result = await runEditorGit(root, ["add", "-A", "--", ...paths.map((path) => `./${path}`)]);
    if (result.code !== 0) throw gitFailure(result, "git add failed");
    return jsonResponse(await gitStatus(root));
  });

  addRoute(routes, "POST", "/workspace/:id/editor/git/unstage", "client", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const paths = pathsOf(body.paths);
    const root = await gitWrite(ctx, `Unstage ${paths.length} file(s)`);
    const hasHead = (await runEditorGit(root, ["rev-parse", "--verify", "-q", "HEAD"], { timeoutMs: 5_000 })).code === 0;
    const specs = paths.map((path) => `./${path}`);
    const result = hasHead
      ? await runEditorGit(root, ["reset", "-q", "HEAD", "--", ...specs])
      : await runEditorGit(root, ["rm", "-r", "-q", "--cached", "--", ...specs]);
    if (result.code !== 0) throw gitFailure(result, "git unstage failed");
    return jsonResponse(await gitStatus(root));
  });

  addRoute(routes, "POST", "/workspace/:id/editor/git/commit", "client", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const message = typeof body.message === "string" ? body.message.replace(/\r\n/g, "\n").trim() : "";
    if (!message) throw new ApiError(400, "invalid_payload", "A commit message is required");
    if (message.length > COMMIT_MESSAGE_MAX) throw new ApiError(400, "invalid_payload", "The commit message is too long");
    const root = await gitWrite(ctx, "Commit staged changes");
    // The message goes in on stdin: never parsed as an option, any length.
    const result = await runEditorGit(root, ["commit", "-q", "-F", "-"], { input: `${message}\n`, timeoutMs: 120_000 });
    if (result.code !== 0) throw gitFailure(result, "git commit failed");
    const head = await runEditorGit(root, ["rev-parse", "--short", "HEAD"], { timeoutMs: 5_000 });
    return jsonResponse({ ok: true, commit: head.stdout.toString("utf8").trim(), status: await gitStatus(root) });
  });
}
