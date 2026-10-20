// Types of worktree-tasks.mjs (the shared module itself is plain JavaScript).

export type TaskState = "created" | "running" | "done" | "failed" | "stopped" | "applied" | "merged" | "missing";

export type TaskRecord = {
  version: number;
  id: string;
  title: string;
  prompt: string;
  origin: string;
  repo: string;
  repoName: string;
  path: string;
  branch: string;
  baseBranch: string | null;
  baseCommit: string;
  state: TaskState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  sessionId: string | null;
  parentSessionId: string | null;
  pid: number | null;
  exitCode: number | null;
  summary: string | null;
  log: string | null;
  result: { mode: "apply" | "merge"; files: number; at: string } | null;
  /** The main checkout had uncommitted changes when the task started (they are not in it). */
  startedDirty?: boolean;
  pidStart?: string | null;
};

export type RepoInfo = {
  top: string;
  here: string;
  commonDir: string;
  branch: string | null;
  head: string | null;
  name: string;
  inWorktree: boolean;
};

export type TaskChange = { status: string; file: string };

export const TASKS_VERSION: number;
export const TASKS_SUFFIX: string;
export const RECORDS_DIR: string;
export const BRANCH_PREFIX: string;
export const TASK_STARTED_EVENT: "worktree.task_started";
export const TASK_MERGED_EVENT: "worktree.task_merged";
export const STATES: readonly TaskState[];

export class TaskError extends Error {
  constructor(message: string, code?: string, details?: unknown);
  code: string;
  details?: unknown;
}

export function runGit(args: string[], options?: { cwd?: string; env?: Record<string, string>; input?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
export function repoOf(dir: string): Promise<RepoInfo | null>;
export function tasksDir(top: string): string;
export function recordsDir(top: string): string;
export function recordPath(top: string, id: string): string;
export function slugify(text: string, max?: number): string;
export function titleFor(prompt: string): string;
export function newTaskId(now?: number, random?: Uint8Array): string;
export function createTask(input: { dir: string; prompt: string; title?: string | null; origin?: string; parentSessionId?: string | null; now?: number }): Promise<TaskRecord>;
export function updateTask(record: TaskRecord, patch: Partial<TaskRecord> | ((current: TaskRecord) => Partial<TaskRecord>)): Promise<TaskRecord>;
export function updateTaskFile(file: string, patch: Partial<TaskRecord>): Promise<TaskRecord | null>;
export function processStartTime(pid: number | null): string | null;
export function pidAlive(pid: number | null, record?: TaskRecord | null): boolean;
export function reconcile(record: TaskRecord, options?: { alive?: (pid: number | null, record?: TaskRecord | null) => boolean }): Promise<TaskRecord>;
export function readTask(dir: string, id: string): Promise<TaskRecord>;
export function listTasks(dir: string, options?: { repo?: RepoInfo; alive?: (pid: number | null, record?: TaskRecord | null) => boolean }): Promise<TaskRecord[]>;
export function findTask(dir: string, ref: string, options?: { repo?: RepoInfo }): Promise<TaskRecord>;
export function taskChanges(task: TaskRecord): Promise<TaskChange[]>;
export function taskFileCount(task: TaskRecord): Promise<number | null>;
export function taskPatch(task: TaskRecord): Promise<string>;
export function taskStat(task: TaskRecord): Promise<string>;
export function bringBack(task: TaskRecord, options?: { mode?: "apply" | "merge"; message?: string; now?: number }): Promise<{ record: TaskRecord; files: TaskChange[]; mode: "apply" | "merge" }>;
export function gitBusy(dir: string): Promise<"merge" | "rebase" | "cherry-pick" | "revert" | null>;
export function isTaskPath(repo: string, folder: string): boolean;
export function removeTask(task: TaskRecord, options?: { keepBranch?: boolean; force?: boolean; alive?: (pid: number | null, record?: TaskRecord | null) => boolean }): Promise<{ removed: boolean; branchKept: boolean }>;
export function cleanTasks(dir: string, options?: { keepBranch?: boolean; force?: boolean; alive?: (pid: number | null, record?: TaskRecord | null) => boolean }): Promise<string[]>;
export function taskStartedData(task: TaskRecord): Record<string, unknown>;
export function taskMergedData(task: TaskRecord, result: { mode: "apply" | "merge"; files: TaskChange[] | number }): Record<string, unknown>;
export function isFinished(task: TaskRecord): boolean;
export function stateLabel(state: TaskState | string): string;

/** The environment git gets (hooks are the repository's code): basics and git's own non-credential settings only. */
export function gitEnvironment(base?: Record<string, string | undefined>): Record<string, string>;
