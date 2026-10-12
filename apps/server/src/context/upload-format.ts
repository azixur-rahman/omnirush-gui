// The upload format (trace schema 2 or 3) the uploader sends, the same file in
// omnirush-cli (assets/extensions/omnirush/capture/context/) and omnirush-gui
// (apps/server/src/context/), listed in PARITY.sha256.
//
// GET /collect/capabilities says whether the server takes schema 3. Its answer
// is remembered on disk per server for REMEMBER_MS, so a failed check (a 401,
// a 5xx, a timeout, no network) keeps the format the server last advertised
// instead of falling back. Only an explicit refusal of schema 3 by /collect
// (422 unsupported_schema: unsupported()) moves a known server back to schema
// 2. With nothing known and a failed check the upload goes out as schema 2,
// and the server is asked again after RETRY_MS rather than RECHECK_MS.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const UPLOAD_FORMAT_FILE = "upload-format.json";
/** How long a server's schema 3 is remembered after it last advertised it. */
export const REMEMBER_MS = 7 * 24 * 60 * 60_000;
/** How long an answer (or a refusal) stands before the server is asked again. */
export const RECHECK_MS = 5 * 60_000;
/** How soon the server is asked again after a check that failed. */
export const RETRY_MS = 30_000;

export type UploadSchema = 2 | 3;

export type UploadFormatAnswer = { schema_versions?: unknown; canonical_trace?: unknown };

export type UploadFormatOptions<Answer extends UploadFormatAnswer> = {
  /** The remembered formats (<state dir>/upload-format.json); null keeps them in memory only. */
  file: string | null;
  /** The server the uploads go to; formats are remembered per server. */
  server: () => string;
  /** GET /collect/capabilities; throws when it got no usable answer. None: schema 2. */
  probe?: () => Promise<Answer>;
  /** Sees each answer (its features); its errors are ignored. */
  onAnswer?: (answer: Answer) => void;
  log?: (level: "info" | "warn", message: string, attributes?: Record<string, unknown>) => void;
  now?: () => number;
};

type Remembered = { schema: 3; confirmed_at: number };
type Stored = { servers: Record<string, Remembered> };

/** Whether an answer of GET /collect/capabilities offers schema 3. */
export function advertisesSchema3(answer: UploadFormatAnswer | null | undefined): boolean {
  return Boolean(answer)
    && answer!.canonical_trace === true
    && Array.isArray(answer!.schema_versions)
    && answer!.schema_versions.includes(3);
}

/** The key a server is remembered under: its URL without a trailing slash. */
export function uploadFormatServerKey(server: string): string {
  return server.trim().replace(/\/+$/, "").toLowerCase() || "default";
}

export class UploadFormat<Answer extends UploadFormatAnswer = UploadFormatAnswer> {
  private cache: { server: string; version: UploadSchema; until: number } | null = null;
  private pending: { server: string; promise: Promise<UploadSchema> } | null = null;
  private generation = 0;
  private memory: Stored = { servers: {} };
  private readonly now: () => number;

  constructor(private readonly options: UploadFormatOptions<Answer>) {
    this.now = options.now ?? Date.now;
  }

  /** The schema to send now; asks the server when the last decision is due. */
  version(force = false): Promise<UploadSchema> {
    const server = uploadFormatServerKey(this.options.server());
    const now = this.now();
    if (!force && this.cache && this.cache.server === server && this.cache.until > now) return Promise.resolve(this.cache.version);
    if (this.pending && this.pending.server === server) return this.pending.promise;
    const generation = this.generation;
    const promise = this.decide(server).then(({ version, recheckMs }) => {
      if (generation === this.generation) this.cache = { server, version, until: this.now() + recheckMs };
      return version;
    }).finally(() => {
      if (this.pending?.promise === promise) this.pending = null;
    });
    this.pending = { server, promise };
    return promise;
  }

  /** /collect refused schema 3 (422 unsupported_schema): schema 2, and the server's schema 3 is forgotten. */
  unsupported(): void {
    const server = uploadFormatServerKey(this.options.server());
    this.generation += 1;
    this.pending = null;
    this.cache = { server, version: 2, until: this.now() + RECHECK_MS };
    const stored = this.read();
    if (!stored.servers[server]) return;
    delete stored.servers[server];
    this.write(stored);
    this.options.log?.("warn", "OmniRush session upload: the server refused schema 3; sending schema 2", { server });
  }

  /** Asks again at the next upload (sign-out); what is remembered on disk stays. */
  reset(): void {
    this.generation += 1;
    this.cache = null;
    this.pending = null;
  }

  /** Whether `server` advertised schema 3 within REMEMBER_MS (on disk, so other processes' answers count). */
  remembers(server: string): boolean {
    const entry = this.read().servers[uploadFormatServerKey(server)];
    return Boolean(entry) && entry!.schema === 3 && this.now() - entry!.confirmed_at < REMEMBER_MS;
  }

  private async decide(server: string): Promise<{ version: UploadSchema; recheckMs: number }> {
    if (!this.options.probe) return { version: 2, recheckMs: RECHECK_MS };
    let answer: Answer;
    try {
      answer = await this.options.probe();
    } catch (error) {
      const remembered = this.remembers(server);
      this.options.log?.("warn", "OmniRush session upload: the upload format check failed", {
        error: error instanceof Error ? error.message : "unknown",
        schema: remembered ? 3 : 2,
      });
      return { version: remembered ? 3 : 2, recheckMs: RETRY_MS };
    }
    try {
      this.options.onAnswer?.(answer);
    } catch {
      /* the answer still counts */
    }
    if (advertisesSchema3(answer)) {
      this.remember(server);
      return { version: 3, recheckMs: RECHECK_MS };
    }
    // An answer without schema 3 never undoes a remembered one: only /collect's refusal does.
    return { version: this.remembers(server) ? 3 : 2, recheckMs: RECHECK_MS };
  }

  private remember(server: string): void {
    const stored = this.read();
    const entry = stored.servers[server];
    // Written at most once a minute per server (several processes share the file).
    if (entry && entry.schema === 3 && this.now() - entry.confirmed_at < 60_000) return;
    stored.servers[server] = { schema: 3, confirmed_at: this.now() };
    this.write(stored);
  }

  private read(): Stored {
    if (!this.options.file) return this.memory;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.options.file, "utf8"));
      const servers = parsed && typeof parsed === "object" ? (parsed as { servers?: unknown }).servers : null;
      const out: Stored = { servers: {} };
      if (servers && typeof servers === "object") {
        for (const [key, value] of Object.entries(servers as Record<string, unknown>)) {
          const entry = value as Partial<Remembered> | null;
          if (entry && entry.schema === 3 && typeof entry.confirmed_at === "number" && Number.isFinite(entry.confirmed_at)) {
            out.servers[key] = { schema: 3, confirmed_at: entry.confirmed_at };
          }
        }
      }
      this.memory = out;
      return out;
    } catch {
      // Missing or unreadable: what this process saw last.
      return this.memory;
    }
  }

  private write(stored: Stored): void {
    this.memory = stored;
    const file = this.options.file;
    if (!file) return;
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(temp, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
      renameSync(temp, file);
    } catch {
      try {
        rmSync(temp, { force: true });
      } catch {
        /* nothing to clean */
      }
    }
  }
}
