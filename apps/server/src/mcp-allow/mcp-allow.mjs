// MCP servers in the managed engine: the server's list of the ones a session
// may use (GET /collect/capabilities `mcp`), applied to the engine's final
// configuration by the engine plugin (createMcpPolicyHooks).
//
// The same file ships in omnirush-cli (src/mcp/) and omnirush-gui
// (apps/server/src/mcp-allow/); PARITY.sha256 lists it in both. No imports
// beyond node: built-ins, so the desktop's plugin bundler and the CLI's
// plain node both load it as is.
//
// A server is allowed only when it is a LOCAL program the app can name:
// launched through npx/bunx/pnpm dlx/yarn dlx/npm exec (npm) or uvx/uv tool
// run (PyPI) with a package on the server's list, at a version in the
// entry's range (an unpinned launch runs the entry's `pin`), and with every
// folder or file it works on inside the project. Remote servers, servers the
// app cannot name (a script path, docker, a bare binary) and everything not on
// the list are left out of the engine; the report says which and why.
//
// Allowed servers are keyed by the entry's id (the engine names their tools
// `<id>_<tool>`), so the same server gets the same tool names whatever the
// user called it. With the project's sandbox on, they run in the sandbox.
//
// One exception, account servers (Figma): an entry with `runtime: "remote"`
// matches its exact address only (no headers or OAuth settings from a config
// file, where a token would travel with the project), and an entry whose
// `rules.secret_env` names a key reads it from the person's own environment
// only, never writes it into the server's settings, and runs on this computer
// (the sandbox never sees the key). `read_tools` lists the tools that run
// without asking in Normal (every other one asks).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const MCP_POLICY_FILE_VERSION = 1;

/** The empty folder npx runs from inside the sandbox (see `launchCommand`). */
export const BOX_NPM_PREFIX = "/tmp/omnirush-mcp-npx";

/** Messages people see, by decision code. */
export const MCP_REASONS = {
  disabled: "MCP servers are turned off for this account.",
  remote: "Remote MCP servers are not supported: their answers come from an outside service or account, so the session could not be repeated.",
  unknown_command: "The app cannot tell which MCP server this is. Start it with npx (npm packages) or uvx (Python packages) and the package name.",
  not_allowed: "This MCP server is not on the supported list. Supported servers work only on the project's own files.",
  denied: "This MCP server is not supported.",
  version: "This version of the MCP server is not supported.",
  outside_project: "This MCP server may only use files inside the project folder.",
  missing_flag: "This MCP server needs a setting that points at a file in the project.",
  missing_arg: "This MCP server needs the file it works on, inside the project, as its argument.",
  flag: "This MCP server setting is not supported: it reaches outside the project.",
  secret_flag: "A key or token is not supported in a config file (it would travel with the project): set it in your environment instead.",
  duplicate: "Another entry already starts this MCP server.",
  invalid: "This MCP server entry is not valid.",
  runner_missing: "npx or uvx was not found on this computer outside the project folder, so the server does not start.",
  secret_missing: "This MCP server needs a key in your own environment (not in a config file).",
  remote_settings: "This remote MCP server is supported only with its plain address: no headers or other settings.",
};

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NPM_RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const DLX_RUNNERS = new Set(["pnpm", "yarn"]);
const PY_RUNNERS = new Set(["uvx"]);
// Flags of the runners that take a value (the next word).
const NPX_VALUE_FLAGS = new Set(["-p", "--package", "--registry", "--cache", "--userconfig", "-c", "--call", "--prefix", "-w", "--workspace"]);
const UVX_VALUE_FLAGS = new Set(["--from", "--with", "--with-requirements", "--python", "-p", "--index", "--index-url", "--extra-index-url", "--default-index", "--directory", "--project", "--cache-dir", "--config-file", "--with-editable"]);
const LOCAL_URL = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w.-]+\.localhost)(:\d+)?(\/|$|\?|#)|^(about|data):/i;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value, limit = 64) {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string" && v.length > 0 && v.length < 300).slice(0, limit) : [];
}

function text(value, limit = 400) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;
}

// ------------------------------------------------------------------ versions

/** Numeric parts of a plain dotted version ("2026.8.31", "0.0.83"); null for anything else. */
export function versionParts(value) {
  const match = /^v?(\d+(?:\.\d+){0,3})$/.exec(String(value ?? "").trim());
  return match ? match[1].split(".").map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Whether `version` is in `range`: "*" (or empty) is any version; otherwise
 * space-separated terms that all hold, each `>=x`, `>x`, `<=x`, `<x`, `=x`
 * or a bare `x`. Only plain dotted versions match a range other than "*".
 */
export function versionInRange(version, range) {
  const wanted = String(range ?? "*").trim();
  if (wanted === "" || wanted === "*") return true;
  const have = versionParts(version);
  if (!have) return false;
  return wanted.split(/\s+/).every((term) => {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(term);
    const want = m ? versionParts(m[2]) : null;
    if (!want) return false;
    const c = compare(have, want);
    switch (m[1] ?? "=") {
      case ">=": return c >= 0;
      case ">": return c > 0;
      case "<=": return c <= 0;
      case "<": return c < 0;
      default: return c === 0;
    }
  });
}

/** Whether `range` is one versionInRange understands. */
export function validRange(range) {
  const wanted = String(range ?? "*").trim();
  if (wanted === "" || wanted === "*") return true;
  return wanted.split(/\s+/).every((term) => {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(term);
    return Boolean(m && versionParts(m[2]));
  });
}

// -------------------------------------------------------------------- policy

// The variables a local MCP server sees from the engine's own environment: what a program needs to
// start on this computer, and the network's proxy, certificate and package registry settings. The
// engine starts a server with its whole environment plus the entry's `environment`, so every other
// variable it has (the app's tokens, the engine's password, the person's other keys) is set empty for
// the server (mcpServerEnvironment). The server's own path_env / fixed_env and the key its rules name
// (secret_env) are added on top. A name the engine does not have is never set, not even empty.
export const MCP_ENV_ALLOW = Object.freeze([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG", "LANGUAGE", "TZ", "TERM", "COLORTERM",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "USERNAME", "USERDOMAIN", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "HOMEDRIVE", "HOMEPATH",
  "SYSTEMDRIVE", "ALLUSERSPROFILE", "PUBLIC", "COMPUTERNAME", "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "__CF_USER_TEXT_ENCODING",
  // Kept as they are, even when a proxy address carries its own login: the server's package
  // manager needs the network's proxy, and the person set it for every program on this computer.
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
  "NPM_CONFIG_REGISTRY", "NPM_CONFIG_CAFILE", "NPM_CONFIG_PROXY", "NPM_CONFIG_HTTPS_PROXY", "NPM_CONFIG_NOPROXY", "NPM_CONFIG_STRICT_SSL",
  "UV_INDEX_URL", "UV_DEFAULT_INDEX", "UV_NATIVE_TLS", "PIP_INDEX_URL",
  "UV_INDEX", "UV_EXTRA_INDEX_URL", "UV_INSECURE_HOST", "CURL_CA_BUNDLE", "PIP_CERT", "NPM_CONFIG_USERCONFIG",
  // The desktop session, so a server can open a window (a headed browser on Linux).
  "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "PLAYWRIGHT_BROWSERS_PATH",
]);
// Locale, desktop folders, Volta and git's own settings (identity, config file, ssh, certificates).
const MCP_ENV_ALLOW_PREFIX = /^(?:LC_|XDG_|VOLTA_|GIT_)/i;
// Git settings that can carry a login or start a helper that hands one out (http.extraHeader through
// GIT_CONFIG_*, an askpass or credential helper): empty for a server like every other variable.
const MCP_ENV_GIT_CREDENTIAL = /^GIT_(?:ASKPASS$|CREDENTIAL|HTTP_EXTRAHEADER|CONFIG_PARAMETERS$|CONFIG_COUNT$|CONFIG_KEY_|CONFIG_VALUE_)|(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|AUTH|CREDENTIALS?|ASKPASS|COOKIE|KEY)(?:_|$)/i;
// Never reaches a server, whatever its rules say.
const MCP_ENV_NEVER = /^(?:OMNIRUSH_|OPENCODE_SERVER_|OPENCODE_PASSWORD$)/i;

/**
 * The `environment` a local MCP server gets from the app: `own` (its
 * path_env / fixed_env values), every other variable of `engineEnv` set empty
 * (the engine merges its own environment under it), except the allowed
 * basics (MCP_ENV_ALLOW) and the keys in `keep` (the server's secret_env).
 */
export function mcpServerEnvironment(engineEnv, own = {}, keep = [], platform = process.platform) {
  const norm = (k) => (platform === "win32" ? k.toUpperCase() : k);
  const allowed = new Set(MCP_ENV_ALLOW.map((k) => k.toUpperCase()));
  const kept = new Set(keep.filter((k) => !MCP_ENV_NEVER.test(k)).map(norm));
  const ownKeys = new Set(Object.keys(own).map(norm));
  const out = {};
  for (const [key, value] of Object.entries(engineEnv ?? {})) {
    // Only a variable the engine has (set, not empty) is emptied: an empty one would change what a
    // program does when it is not set at all (git's identity, Volta's home).
    if (typeof value !== "string" || value === "") continue;
    if (ownKeys.has(norm(key))) continue;
    const upper = key.toUpperCase();
    const basic = (allowed.has(upper) || (MCP_ENV_ALLOW_PREFIX.test(key) && !MCP_ENV_GIT_CREDENTIAL.test(key))) && !MCP_ENV_NEVER.test(key);
    if (basic || kept.has(norm(key))) continue;
    out[key] = "";
  }
  // A name the app keeps from every server is empty even when the server's own variables name it.
  for (const [key, value] of Object.entries(own)) out[key] = MCP_ENV_NEVER.test(key) ? "" : value;
  return out;
}

function normalizeRules(value) {
  const rules = isRecord(value) ? value : {};
  const out = {};
  if (rules.path_args === "positional") out.path_args = "positional";
  if (Number.isInteger(rules.min_args) && rules.min_args > 0 && rules.min_args < 9) out.min_args = rules.min_args;
  if (isRecord(rules.flag_values)) {
    const values = Object.fromEntries(Object.entries(rules.flag_values)
      .filter(([k, v]) => /^-{1,2}[\w-]+$/.test(k) && Array.isArray(v))
      .map(([k, v]) => [k, strings(v, 16)])
      .slice(0, 16));
    if (Object.keys(values).length) out.flag_values = values;
  }
  const defaults = strings(rules.default_args, 8);
  if (defaults.length) out.default_args = defaults;
  for (const key of ["path_flags", "require_flags", "add_flags", "forbid_flags", "allow_flags"]) {
    const list = strings(rules[key], 32).filter((f) => f.startsWith("-") && (key === "add_flags" || !f.includes("=")));
    if (list.length) out[key] = list;
  }
  if (isRecord(rules.path_env)) {
    const env = Object.fromEntries(Object.entries(rules.path_env)
      .filter(([k, v]) => !MCP_ENV_NEVER.test(k) && /^[A-Z_][A-Z0-9_]{0,63}$/.test(k) && typeof v === "string" && v.length < 200 && !path.isAbsolute(v) && !v.split(/[\\/]/).includes(".."))
      .slice(0, 8));
    if (Object.keys(env).length) out.path_env = env;
  }
  if (rules.local_urls === true) out.local_urls = true;
  // Keys a server needs, read only from the person's own environment (never from a config file, which the
  // project upload could carry); the first one present is passed on, none present: blocked.
  const secrets = strings(rules.secret_env, 4).filter((k) => /^[A-Z_][A-Z0-9_]{0,63}$/.test(k) && !MCP_ENV_NEVER.test(k));
  if (secrets.length) out.secret_env = secrets;
  const inputs = strings(rules.path_inputs, 16).filter((k) => /^[A-Za-z_][\w]{0,63}$/.test(k));
  if (inputs.length) out.path_inputs = inputs;
  return out;
}

/** A remote server's address as compared: scheme, host and path, lower-case host, no trailing slash. */
// The same check as the backend's mcp_policy.remote_url (test/fixtures/mcp-remote-urls.json, both sides): plain
// host names only (no escapes, IP shortcuts or trailing dot), a port without leading zeros, a path without
// escapes or dot segments, no user, query or fragment.
// Token shapes a key server's arguments must not hold (Figma's personal and OAuth tokens).
const TOKEN_SHAPE = /(?:^|[^A-Za-z0-9_])fig(?:d|u|ur)_[A-Za-z0-9_-]{20,}/;
const REMOTE_URL = /^(https?):\/\/((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[::1\])(?::([1-9][0-9]{0,4}))?(\/[A-Za-z0-9._~/-]*)?$/i;

export function normalizeRemoteUrl(value) {
  if (typeof value !== "string" || value.length > 300) return null;
  const m = REMOTE_URL.exec(value);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  let host = m[2].toLowerCase();
  let port = m[3] ?? null;
  const path = m[4] ?? "";
  if (port !== null && Number(port) > 65535) return null;
  if (path.split("/").some((part) => part === "." || part === "..")) return null;
  // Plain http only to this computer (the Figma desktop app's server); anything else must be https.
  if (scheme === "http" && !["127.0.0.1", "localhost", "[::1]"].includes(host)) return null;
  // localhost and 127.0.0.1 name the same server here.
  if (host === "localhost") host = "127.0.0.1";
  if ((scheme === "https" && port === "443") || (scheme === "http" && port === "80")) port = null;
  return `${scheme}://${host}${port ? `:${port}` : ""}${path.replace(/\/+$/, "") || "/"}`;
}

function normalizeRemoteEntry(value, id) {
  const url = normalizeRemoteUrl(value.url);
  const pkg = text(value.package, 214);
  if (!url || !pkg || !/^(@[\w.-]+\/)?[\w.-]+$/.test(pkg)) return null;
  return {
    id,
    runtime: "remote",
    package: pkg,
    url,
    // OAuth sign-in through the engine (its own token store, never a config file); false: none.
    oauth: value.oauth === true,
    bins: [],
    versions: "*",
    pin: null,
    title: text(value.title, 80) ?? id,
    why: text(value.why, 400),
    setup: text(value.setup, 400),
    write_tools: Array.isArray(value.write_tools) ? strings(value.write_tools, 64).filter((t) => /^[\w-]{1,64}$/.test(t)) : null,
    // Or the other way round: only these run without asking (a server whose tool list grows, such as Figma's).
    read_tools: Array.isArray(value.read_tools) ? strings(value.read_tools, 64).filter((t) => /^[\w-]{1,64}$/.test(t)) : null,
    rules: {},
  };
}

function normalizeEntry(value) {
  if (!isRecord(value)) return null;
  const id = text(value.id, 40)?.toLowerCase();
  if (value.runtime === "remote") return id && ID.test(id) ? normalizeRemoteEntry(value, id) : null;
  const runtime = value.runtime === "npm" || value.runtime === "pypi" ? value.runtime : null;
  const pkg = text(value.package, 214);
  if (!id || !ID.test(id) || !runtime || !pkg || !/^(@[\w.-]+\/)?[\w.-]+$/.test(pkg)) return null;
  const pin = text(value.pin, 40);
  if (pin && !versionParts(pin)) return null;
  const versions = text(value.versions, 120) ?? "*";
  if (!validRange(versions)) return null;
  if (pin && !versionInRange(pin, versions)) return null;
  return {
    id,
    runtime,
    package: pkg,
    bins: strings(value.bins, 8),
    versions,
    pin,
    title: text(value.title, 80) ?? id,
    why: text(value.why, 400),
    setup: text(value.setup, 400),
    // The server's tools that change something (files, a database, the
    // repository, the memory file): Normal permission mode asks before them.
    // null (a list without the field): every tool counts as one that changes something.
    write_tools: Array.isArray(value.write_tools) ? strings(value.write_tools, 64).filter((t) => /^[\w-]{1,64}$/.test(t)) : null,
    // Or the other way round: only these run without asking (a server whose tool list grows, such as Figma's).
    read_tools: Array.isArray(value.read_tools) ? strings(value.read_tools, 64).filter((t) => /^[\w-]{1,64}$/.test(t)) : null,
    rules: normalizeRules(value.rules),
  };
}

function normalizeDeny(value) {
  if (typeof value === "string") return text(value, 214) ? { match: value.trim().toLowerCase(), reason: null } : null;
  if (!isRecord(value)) return null;
  const match = text(value.match, 214)?.toLowerCase();
  return match ? { match, reason: text(value.reason, 400) } : null;
}

/**
 * The `mcp` block of a /collect/capabilities answer as the app uses it:
 * `{enabled, allow, deny, message}`; null when absent or unreadable (MCP off).
 */
export function normalizePolicy(block) {
  if (!isRecord(block)) return null;
  const allow = [];
  const seen = new Set();
  for (const raw of Array.isArray(block.allow) ? block.allow.slice(0, 64) : []) {
    const entry = normalizeEntry(raw);
    const key = entry ? `${entry.id}|${entry.runtime}|${entry.package}|${entry.url ?? ""}` : null;
    if (entry && !seen.has(key)) { seen.add(key); allow.push(entry); }
  }
  const deny = (Array.isArray(block.deny) ? block.deny.slice(0, 128) : []).map(normalizeDeny).filter(Boolean);
  return { enabled: block.enabled === true, allow, deny, message: text(block.message, 400) };
}

// -------------------------------------------------------------- the launches

function programName(word) {
  return String(word || "").split(/[\\/]/).pop().toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, "");
}

/** `@scope/name@1.2.3` / `name@1.2.3` / `name==1.2.3` -> {name, version}. */
export function splitSpec(spec, runtime) {
  const raw = String(spec || "");
  if (runtime === "pypi") {
    const eq = /^([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])?\s*(?:==|@)\s*([\w.+-]+)$/.exec(raw);
    if (eq) return { name: eq[1].toLowerCase(), version: eq[2] };
    const bare = /^([A-Za-z0-9][\w.-]*)(?:\[[^\]]*\])?$/.exec(raw);
    return bare ? { name: bare[1].toLowerCase(), version: null } : null;
  }
  const m = /^((?:@[\w.-]+\/)?[\w.-]+)(?:@(.+))?$/.exec(raw);
  if (!m) return null;
  return { name: m[1].toLowerCase(), version: m[2] && m[2] !== "latest" ? m[2] : null };
}

/**
 * What a local launch runs, or null when the app cannot name it:
 * `{runtime, name, version, bin, prefix, rest, specIndex, viaFrom}` where
 * `command[specIndex]` is the package spec (the one rewritten to pin) and
 * `rest` the server's own arguments.
 */
export function parseLaunch(command) {
  const argv = strings(command, 256);
  if (argv.length === 0 || argv.length !== (Array.isArray(command) ? command.length : -1)) return null;
  const prog = programName(argv[0]);
  let i = 1;
  let runtime = null;
  if (NPM_RUNNERS.has(prog)) runtime = "npm";
  else if (DLX_RUNNERS.has(prog) && argv[1] === "dlx") { runtime = "npm"; i = 2; }
  else if (prog === "npm" && (argv[1] === "exec" || argv[1] === "x")) { runtime = "npm"; i = 2; }
  else if (PY_RUNNERS.has(prog)) runtime = "pypi";
  else if (prog === "uv" && argv[1] === "tool" && argv[2] === "run") { runtime = "pypi"; i = 3; }
  if (!runtime) return null;
  const runner = prog === "uv" ? "uv" : prog;
  const valueFlags = runtime === "npm" ? NPX_VALUE_FLAGS : UVX_VALUE_FLAGS;
  let from = null;
  let fromIndex = -1;
  for (; i < argv.length; i += 1) {
    const word = argv[i];
    if (word === "--") { i += 1; break; }
    if (!word.startsWith("-")) break;
    const [flag, inline] = word.includes("=") ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)] : [word, null];
    const isFrom = runtime === "npm" ? flag === "-p" || flag === "--package" : flag === "--from";
    if (runtime === "npm" && (flag === "-c" || flag === "--call")) return null;
    if (runtime === "pypi" && (flag === "--with" || flag === "--with-requirements" || flag === "--with-editable" || flag.includes("index") || flag === "--directory" || flag === "--project")) return null;
    if (runtime === "npm" && (flag === "--registry" || flag === "--prefix" || flag === "-w" || flag === "--workspace")) return null;
    if (valueFlags.has(flag)) {
      if (inline === null) {
        if (isFrom) { if (from !== null) return null; from = argv[i + 1] ?? null; fromIndex = i + 1; }
        i += 1;
      } else if (isFrom) { if (from !== null) return null; from = inline; fromIndex = -2 - i; }
    }
  }
  if (i >= argv.length) return null;
  const first = argv[i];
  const spec = from ?? first;
  const parsed = splitSpec(spec, runtime);
  if (!parsed) return null;
  return {
    runtime,
    name: parsed.name,
    version: parsed.version,
    bin: from !== null ? programName(splitSpec(first, runtime)?.name ?? first) : null,
    specIndex: from !== null ? fromIndex : i,
    rest: argv.slice(i + 1),
    restIndex: i + 1,
    runner,
  };
}

/**
 * The command the engine runs for an allowed server: always `npx` or `uvx`
 * by bare name (never a program path from the config), the entry's own
 * package at the exact version, and runner settings that keep the project
 * out of how it is fetched: npx runs from an empty `--prefix` folder, so a
 * project's .npmrc (registry, node-options, script-shell) and its own
 * node_modules copy of the package are not used; uvx runs with
 * --no-config, so a project's uv.toml / pyproject.toml index settings are
 * not either.
 */
export function launchCommand(entry, launch, version, npmPrefix) {
  if (entry.runtime === "npm") {
    const spec = `${entry.package}@${version}`;
    return ["npx", "--prefix", npmPrefix, "-y", ...(launch.bin ? ["-p", spec, launch.bin] : [spec])];
  }
  return ["uvx", "--no-config", ...(launch.bin ? ["--from", `${entry.package}==${version}`, launch.bin] : [`${entry.package}@${version}`])];
}

/**
 * The program words that start `runner` (an absolute path from resolveRunner). On Windows npx is a batch
 * file (npx.cmd): cmd.exe re-reads its arguments, and the batch first runs npm's prefix lookup in the current
 * folder (the project, whose .npmrc could point it at a copy of npx inside the project). So the batch never
 * runs: npm's own `node.exe` beside it runs `node_modules/npm/bin/npx-cli.js` directly. null when they are
 * not there. Anything else is started as found.
 */
export function windowsDirect(found, platform = process.platform, exists = existsSync) {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(found)) return [found];
  const dir = path.win32.dirname(found);
  const node = path.win32.join(dir, "node.exe");
  const cli = path.win32.join(dir, "node_modules", "npm", "bin", `${path.win32.basename(found).replace(/\.(cmd|bat)$/i, "")}-cli.js`);
  return exists(node) && exists(cli) ? [node, cli] : null;
}

/**
 * `runner` (npx, uvx) as an absolute path from PATH: only absolute PATH
 * folders outside the project (after links) count, never the current
 * folder; on Windows the .exe or .cmd file. A project in the home folder (or
 * a drive root) does not rule out the PATH folders under it (nvm, ~/.local/bin):
 * only the folder itself is skipped. `accept` (optional) picks among the
 * matches in PATH order (the first it takes). null when there is none.
 */
export function resolveRunner(runner, { root = null, platform = process.platform, env = process.env, exists = existsSync, home = os.homedir(), accept = null } = {}) {
  const lib = platform === "win32" ? path.win32 : path.posix;
  const raw = platform === "win32" ? (env.Path ?? env.PATH ?? env.path ?? "") : (env.PATH ?? "");
  const exts = platform === "win32" ? [".exe", ".cmd"] : [""];
  for (const dir of String(raw).split(platform === "win32" ? ";" : ":")) {
    const folder = dir.trim().replace(/^"(.*)"$/, "$1");
    if (!folder || !lib.isAbsolute(folder) || (platform === "win32" && !/^[A-Za-z]:[\\/]|^\\\\/.test(folder))) continue;
    if (root) {
      const wide = samePlatformPath(lib.resolve(root), platform) === samePlatformPath(lib.resolve(home), platform)
        || lib.resolve(root) === lib.parse(lib.resolve(root)).root;
      if (wide ? samePlatformPath(lib.resolve(folder), platform) === samePlatformPath(lib.resolve(root), platform) : insideRootReal(root, folder, platform)) continue;
    }
    // The app's own package-manager wrappers (the install log's folder holds an `omnirush-pkg` file) look the
    // real tool up on PATH again, relative entries included: skip them for the tool itself.
    if (exists(lib.join(folder, "omnirush-pkg")) || exists(lib.join(folder, "omnirush-pkg.exe"))) continue;
    for (const ext of exts) {
      const file = lib.join(folder, `${runner}${ext}`);
      if (exists(file) && (!accept || accept(file))) return file;
    }
  }
  return null;
}

// ---------------------------------------------------------------------- paths

function samePlatformPath(p, platform) {
  return platform === "win32" ? p.toLowerCase() : p;
}

/** Whether `p` (relative: to `root`) is `root` or inside it. `~` paths are outside. */
export function insideRoot(root, p, platform = process.platform) {
  const value = String(p ?? "");
  if (!value || value.startsWith("~")) return false;
  const lib = platform === "win32" ? path.win32 : path.posix;
  const base = lib.resolve(root);
  const full = lib.resolve(base, value);
  const rel = lib.relative(samePlatformPath(base, platform), samePlatformPath(full, platform));
  return rel === "" || (!rel.startsWith("..") && !lib.isAbsolute(rel));
}

/**
 * `insideRoot`, and also after links: the deepest part of the path that
 * exists, resolved (a link the project holds, such as `data -> ../../..`,
 * points the server outside the folder however the path reads). Only on
 * this machine's own paths (`platform` is this process's); a path the
 * sandbox alone sees is checked as text.
 */
export function insideRootReal(root, p, platform = process.platform) {
  if (!insideRoot(root, p, platform)) return false;
  if (platform !== process.platform) return true;
  let real;
  try { real = realpathSync(root); } catch { return true; }
  let probe = path.resolve(root, String(p));
  const rest = [];
  while (!existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) return true;
    rest.unshift(path.basename(probe));
    probe = up;
  }
  let resolved;
  try { resolved = realpathSync(probe); } catch { return false; }
  return insideRoot(real, path.join(resolved, ...rest), platform);
}

/** A path inside `root` as the sandbox sees it (`croot`); relative paths stay relative. */
function boxPath(p, root, box, platform) {
  if (!box || !box.croot || box.croot === root) return p;
  const lib = platform === "win32" ? path.win32 : path.posix;
  if (!lib.isAbsolute(p)) return p.split("\\").join("/");
  const rel = lib.relative(lib.resolve(root), lib.resolve(p)).split("\\").join("/");
  return rel ? `${box.croot.replace(/\/+$/, "")}/${rel}` : box.croot;
}

function flagValue(args, flag) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) return { index: i + 1, value: args[i + 1] ?? null, inline: false };
    if (args[i].startsWith(`${flag}=`)) return { index: i, value: args[i].slice(flag.length + 1), inline: true };
  }
  return null;
}

// ------------------------------------------------------------------ the shell

/** POSIX single-quoting for the sandbox shell. */
export function shellQuote(word) {
  const s = String(word);
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

// ------------------------------------------------------------------- evaluate

function denyReason(policy, ...keys) {
  for (const rule of policy.deny) {
    for (const key of keys) {
      if (!key) continue;
      const k = String(key).toLowerCase();
      if (k === rule.match || (rule.match.endsWith("*") && k.startsWith(rule.match.slice(0, -1)))) return rule.reason ?? MCP_REASONS.denied;
    }
  }
  return null;
}

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
}

function blocked(name, code, extra = {}) {
  return { name, status: "blocked", code, ...extra, reason: extra.reason ?? MCP_REASONS[code] ?? MCP_REASONS.invalid };
}

/**
 * Apply `policy` to the engine's `mcp` map. `ctx`: `{root, platform, box,
 * npmPrefix}` where `box` is `{shell, key, croot}` when the project's
 * sandbox is on and `npmPrefix` the empty folder npx runs from.
 * Returns `{mcp, decisions}`: the map the engine gets (allowed servers only,
 * keyed by their ids) and one decision per configured entry.
 */
export function evaluateMcp(mcpMap, policy, ctx = {}) {
  const root = ctx.root || process.cwd();
  const platform = ctx.platform || process.platform;
  const box = ctx.box && typeof ctx.box.shell === "string" && typeof ctx.box.key === "string" ? ctx.box : null;
  const out = {};
  const decisions = [];
  const entries = isRecord(mcpMap) ? Object.entries(mcpMap) : [];
  for (const [name, raw] of entries) {
    if (!isRecord(raw)) { decisions.push(blocked(name, "invalid")); continue; }
    if (!policy || !policy.enabled) { decisions.push(blocked(name, "disabled", policy?.message ? { reason: policy.message } : {})); continue; }
    if (raw.type === "remote" || typeof raw.url === "string") {
      const url = normalizeRemoteUrl(raw.url);
      const remote = url ? policy.allow.find((e) => e.runtime === "remote" && e.url === url) : null;
      if (remote) {
        const base = { id: remote.id, package: remote.package, runtime: "remote", title: remote.title };
        if (Object.hasOwn(out, remote.id)) { decisions.push(blocked(name, "duplicate", base)); continue; }
        // Headers could carry a token into a config file (and the project upload): the plain address only.
        const extra = Object.keys(raw).filter((k) => !["type", "url", "enabled", "timeout", "oauth"].includes(k));
        if (extra.length || (raw.oauth !== undefined && typeof raw.oauth !== "boolean")) {
          decisions.push(blocked(name, "remote_settings", { ...base, reason: `${MCP_REASONS.remote_settings} (${extra.concat(typeof raw.oauth === "object" ? ["oauth"] : []).slice(0, 4).join(", ")})` }));
          continue;
        }
        const next = { type: "remote", url: remote.url, oauth: remote.oauth ? undefined : false, ...(raw.enabled === false ? { enabled: false } : {}), ...(Number.isInteger(raw.timeout) ? { timeout: raw.timeout } : {}) };
        if (next.oauth === undefined) delete next.oauth;
        out[remote.id] = next;
        decisions.push({ name, status: "allowed", code: "allowed", ...base, version: "remote", url: remote.url, oauth: remote.oauth, sandbox: false, enabled: raw.enabled !== false, write_tools: remote.write_tools, read_tools: remote.read_tools, ...(name !== remote.id ? { renamed_to: remote.id } : {}), notes: [remote.oauth ? "signs in with your account in the browser" : "reaches an app on this computer"] });
        continue;
      }
      const reason = denyReason(policy, name, hostOf(raw.url));
      decisions.push(blocked(name, "remote", { url_host: hostOf(raw.url), ...(reason ? { reason: `${reason} ${MCP_REASONS.remote}` } : {}) }));
      continue;
    }
    if (raw.type !== undefined && raw.type !== "local") { decisions.push(blocked(name, "invalid")); continue; }
    const command = Array.isArray(raw.command) ? raw.command : null;
    const launch = command ? parseLaunch(command) : null;
    if (!launch) {
      const reason = denyReason(policy, name);
      decisions.push(blocked(name, reason ? "denied" : "unknown_command", reason ? { reason } : {}));
      continue;
    }
    const denied = denyReason(policy, launch.name);
    if (denied) { decisions.push(blocked(name, "denied", { reason: denied, package: launch.name })); continue; }
    const entry = policy.allow.find((e) => e.runtime !== "remote" && e.runtime === launch.runtime && e.package.toLowerCase() === launch.name);
    if (!entry) { decisions.push(blocked(name, "not_allowed", { package: launch.name })); continue; }
    // `-p <pkg> <program>` / `--from <pkg> <program>`: the program must be one
    // the package itself provides (the entry's `bins`), never `node -e ...`.
    if (launch.bin !== null && !entry.bins.includes(launch.bin)) {
      decisions.push(blocked(name, "unknown_command", { package: launch.name, reason: `${MCP_REASONS.unknown_command} (${launch.bin} is not one of its programs)` }));
      continue;
    }
    const base = { id: entry.id, package: entry.package, runtime: entry.runtime, title: entry.title };
    if (Object.hasOwn(out, entry.id)) { decisions.push(blocked(name, "duplicate", base)); continue; }
    let version = launch.version;
    const notes = [];
    if (version === null) {
      if (!entry.pin) { decisions.push(blocked(name, "version", { ...base, reason: `${MCP_REASONS.version} Name a version (for example ${launch.name}@1.2.3).` })); continue; }
      version = entry.pin;
      notes.push(`runs version ${version}`);
    } else if (!versionParts(version)) {
      // A tag, a range, a file:, git: or npm: alias: not a release the app can name.
      decisions.push(blocked(name, "version", { ...base, version, reason: `${MCP_REASONS.version} Name a plain version like 1.2.3, or leave it out${entry.pin ? ` to run ${entry.pin}` : ""}.` }));
      continue;
    } else if (!versionInRange(version, entry.versions)) {
      decisions.push(blocked(name, "version", { ...base, version, reason: `${MCP_REASONS.version} Supported: ${entry.versions}${entry.pin ? ` (leave the version out to run ${entry.pin})` : ""}.` }));
      continue;
    }
    let rest = command.slice(launch.restIndex);
    const rules = entry.rules;
    // Only the variables the entry's rules name reach the server: others
    // (NODE_OPTIONS, npm_config_*, PYTHONPATH, LD_PRELOAD, tokens ...) could
    // change what runs or what it reaches.
    const given = isRecord(raw.environment) ? raw.environment : {};
    const kept = new Set(Object.keys(rules.path_env ?? {}));
    const environment = Object.fromEntries(Object.entries(given).filter(([k, v]) => kept.has(k) && typeof v === "string"));
    const ignored = Object.keys(given).filter((k) => !kept.has(k));
    if (ignored.length) notes.push(`ignores ${ignored.slice(0, 4).join(", ")}${ignored.length > 4 ? " ..." : ""}`);
    let refusal = null;
    const userEnv = ctx.env ?? process.env;
    if (!refusal && rules.secret_env) {
      // A key server takes its flags only: a bare argument could be the key itself (in the config, and in
      // the process list). A path flag's value is the one argument allowed.
      for (let i = 0; i < rest.length; i += 1) {
        const arg = String(rest[i]);
        // A path flag's value that looks like a token is refused too (a key typed in the wrong place).
        const value = arg.startsWith("-") ? (arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : !arg.includes("=") && (rules.path_flags ?? []).includes(arg) ? String(rest[i + 1] ?? "") : "") : null;
        if (value !== null && !TOKEN_SHAPE.test(value)) { if (!arg.includes("=") && (rules.path_flags ?? []).includes(arg)) i += 1; continue; }
        refusal = blocked(name, "flag", { ...base, version, reason: MCP_REASONS.secret_flag });
        break;
      }
    }
    const secretNames = (rules.secret_env ?? []).filter((k) => typeof userEnv[k] === "string" && userEnv[k] !== "");
    if (!refusal && rules.secret_env && !secretNames.length) {
      refusal = blocked(name, "secret_missing", { ...base, version, reason: `${MCP_REASONS.secret_missing} Set ${rules.secret_env.join(" or ")} before starting the app.` });
    }
    // A server that needs the person's key runs on this computer, where the engine's own environment holds it
    // (the sandbox never sees it, and the key is never written into the server's settings).
    const boxHere = rules.secret_env ? null : box;
    if (box && !boxHere) notes.push("runs on this computer (needs your key)");
    if (rules.allow_flags) {
      const other = rest.map((a) => (a.includes("=") ? a.slice(0, a.indexOf("=")) : a)).find((a) => a.startsWith("-") && !rules.allow_flags.includes(a));
      if (other) refusal = blocked(name, "flag", { ...base, version, reason: `${/key|token|secret|passw/i.test(other) ? MCP_REASONS.secret_flag : MCP_REASONS.flag} (${other})` });
    }
    if (!refusal) for (const [flag, values] of Object.entries(rules.flag_values ?? {})) {
      const found = flagValue(rest, flag);
      if (found && !values.includes(found.value ?? "")) { refusal = blocked(name, "flag", { ...base, version, reason: `${MCP_REASONS.flag} (${flag} ${found.value ?? ""}; supported: ${values.join(", ")})` }); break; }
    }
    if (!refusal) for (const flag of rules.forbid_flags ?? []) {
      if (flagValue(rest, flag)) { refusal = blocked(name, "flag", { ...base, version, reason: `${MCP_REASONS.flag} (${flag})` }); break; }
    }
    if (!refusal) for (const flag of rules.require_flags ?? []) {
      const found = flagValue(rest, flag);
      if (!found || !found.value) { refusal = blocked(name, "missing_flag", { ...base, version, reason: `${MCP_REASONS.missing_flag} (${flag} <file in the project>)` }); break; }
    }
    const cwd = typeof raw.cwd === "string" ? raw.cwd : null;
    if (!refusal && cwd && !insideRootReal(root, cwd, platform)) refusal = blocked(name, "outside_project", { ...base, version, reason: `${MCP_REASONS.outside_project} (cwd ${cwd})` });
    const lib = platform === "win32" ? path.win32 : path.posix;
    const workRoot = cwd ? lib.resolve(root, cwd) : root;
    const inside = (p) => !String(p).startsWith("~") && insideRootReal(root, lib.resolve(workRoot, String(p)), platform);
    if (!refusal && rules.path_args === "positional") {
      const positional = rest.map((a, k) => [a, k]).filter(([a]) => !a.startsWith("-"));
      if (positional.length === 0 && rules.default_args) {
        rest = [...rest, ...rules.default_args];
        notes.push(`opens ${rules.default_args.join(" ")}`);
      }
      for (const [a] of rest.map((a, k) => [a, k]).filter(([a]) => !a.startsWith("-"))) {
        if (!inside(a)) { refusal = blocked(name, "outside_project", { ...base, version, reason: `${MCP_REASONS.outside_project} (${a})` }); break; }
      }
      if (!refusal && rules.min_args && rest.filter((a) => !a.startsWith("-")).length < rules.min_args) {
        refusal = blocked(name, "missing_arg", { ...base, version });
      }
      if (!refusal) rest = rest.map((a) => (a.startsWith("-") ? a : boxPath(a, root, boxHere, platform)));
    }
    if (!refusal) for (const flag of rules.path_flags ?? []) {
      const found = flagValue(rest, flag);
      if (!found || found.value === null) continue;
      if (!inside(found.value)) { refusal = blocked(name, "outside_project", { ...base, version, reason: `${MCP_REASONS.outside_project} (${flag} ${found.value})` }); break; }
      const mapped = boxPath(found.value, root, boxHere, platform);
      rest = [...rest];
      if (found.inline) rest[found.index] = `${flag}=${mapped}`; else rest[found.index] = mapped;
    }
    if (!refusal) for (const [key, fallback] of Object.entries(rules.path_env ?? {})) {
      const value = environment[key];
      if (value === undefined || value === "") {
        environment[key] = boxPath(lib.join(lib.resolve(root), fallback), root, boxHere, platform);
        notes.push(`keeps its data in ${fallback.split("\\").join("/")}`);
      } else if (!inside(value)) {
        refusal = blocked(name, "outside_project", { ...base, version, reason: `${MCP_REASONS.outside_project} (${key})` });
        break;
      } else {
        // Absolute: a server may resolve a relative path against its own install folder.
        environment[key] = boxPath(lib.resolve(workRoot, value), root, boxHere, platform);
      }
    }
    if (refusal) { decisions.push(refusal); continue; }
    for (const flag of rules.add_flags ?? []) {
      const at = flag.indexOf("=");
      if (!flagValue(rest, at > 0 ? flag.slice(0, at) : flag)) { rest = [...rest, flag]; notes.push(`adds ${flag}`); }
    }
    const npmPrefix = boxHere ? BOX_NPM_PREFIX : ctx.npmPrefix || path.join(os.homedir(), ".cache", "omnirush-mcp-npx");
    const argv = [...launchCommand(entry, launch, version, npmPrefix), ...rest];
    if (launch.runner !== (entry.runtime === "npm" ? "npx" : "uvx")) notes.push(`runs with ${argv[0]}`);
    if (!boxHere) {
      // By absolute path: the engine starts the server in the project folder, and on Windows a bare name
      // is looked up there before PATH (a repo's own npx.cmd would run instead).
      const exists = ctx.exists ?? existsSync;
      // The first match on PATH that can be started directly (on Windows, an npx.cmd with npm's node.exe beside it).
      const found = (ctx.resolveRunner ?? resolveRunner)(argv[0], { root, platform, accept: (file) => windowsDirect(file, platform, exists) !== null });
      const program = found ? windowsDirect(found, platform, exists) : null;
      if (!program) { decisions.push(blocked(name, "runner_missing", { ...base, version })); continue; }
      if (platform === "win32" && argv.slice(1).some((a) => /["\r\n%]/.test(a))) {
        decisions.push(blocked(name, "invalid", { ...base, version, reason: `${MCP_REASONS.invalid} (an argument holds a quote, % or a line break)` }));
        continue;
      }
      argv.splice(0, 1, ...program);
    }
    // Only the keys the engine uses for a local server: anything else in the entry (headers, a token under
    // another name) never reaches the engine's config.
    const next = { type: "local", ...Object.fromEntries(["command", "environment", "enabled", "timeout", "cwd"].filter((k) => Object.hasOwn(raw, k)).map((k) => [k, raw[k]])) };
    if (boxHere) {
      const envWords = Object.entries(environment).map(([k, v]) => `${k}=${shellQuote(v)}`);
      next.command = [box.shell, "-c", `${entry.runtime === "npm" ? `mkdir -p ${BOX_NPM_PREFIX} && ` : ""}exec ${envWords.length ? `env ${envWords.join(" ")} ` : ""}${argv.map(shellQuote).join(" ")}`];
      // The box shell needs its key; the engine's other variables are empty for it (mcpServerEnvironment).
      // Its own settings (OMNIRUSH_BOX_HOME and the like: where the box lives, not a credential) stay too.
      const boxVars = Object.fromEntries(Object.entries(userEnv).filter(([k, v]) => /^OMNIRUSH_BOX_/i.test(k) && typeof v === "string"));
      next.environment = { ...mcpServerEnvironment(userEnv, {}, [], platform), ...boxVars, OMNIRUSH_BOX_KEY: box.key };
      notes.push("runs in the sandbox");
    } else {
      next.command = argv;
      // The engine's tokens and the person's other keys never reach the server (mcpServerEnvironment).
      next.environment = mcpServerEnvironment(userEnv, environment, secretNames, platform);
      if (!Object.keys(next.environment).length) delete next.environment;
    }
    if (secretNames.length) notes.push(`uses ${secretNames[0]} from your environment`);
    out[entry.id] = next;
    decisions.push({ name, status: "allowed", code: "allowed", ...base, version, sandbox: Boolean(boxHere), enabled: raw.enabled !== false, write_tools: entry.write_tools, read_tools: entry.read_tools, ...(name !== entry.id ? { renamed_to: entry.id } : {}), notes });
  }
  return { mcp: out, decisions };
}

// ----------------------------------------------------------------- the tools

function urlsIn(args, depth = 0) {
  if (depth > 3) return [];
  if (typeof args === "string") return /^[a-z][a-z0-9+.-]*:/i.test(args) || /^[\w.-]+\.[a-z]{2,}(?:[:/]|$)/i.test(args) ? [args] : [];
  if (Array.isArray(args)) return args.flatMap((v) => urlsIn(v, depth + 1));
  if (!isRecord(args)) return [];
  return Object.entries(args).flatMap(([k, v]) => (/url|uri|href|page|address/i.test(k) ? urlsIn(v, depth + 1) : isRecord(v) || Array.isArray(v) ? urlsIn(v, depth + 1) : []));
}

/** The engine's id of a server's tools: `<sanitized name>_`. */
export function toolPrefix(name) {
  return `${String(name).replace(/[^a-zA-Z0-9_-]/g, "_")}_`;
}

/**
 * Why the engine must not run `tool` with `args`, or null: a `local_urls`
 * server opens pages on this machine only; a `path_inputs` server's tool
 * arguments of those names must be inside the project (`state.roots`: the
 * project folder, and where the sandbox sees it). (Entries left out never
 * reach the engine, so their tools do not exist.)
 */
export function toolRefusal(state, tool, args) {
  const id = String(tool || "");
  for (const entry of state.localOnly ?? []) {
    if (!id.startsWith(toolPrefix(entry))) continue;
    const away = urlsIn(args).find((u) => !LOCAL_URL.test(u.trim()));
    if (away) return `${entry} opens pages on this machine only (localhost) in this app, so the session can be repeated: ${away.slice(0, 200)}`;
  }
  for (const { id: entry, keys } of state.pathInputs ?? []) {
    if (!id.startsWith(toolPrefix(entry)) || !isRecord(args)) continue;
    for (const key of keys) {
      const value = args[key];
      if (value === undefined || value === null || value === "") continue;
      const roots = state.roots ?? [];
      const ok = typeof value === "string" && !value.startsWith("~")
        && roots.some((r) => insideRootReal(r.root, (r.platform === "win32" ? path.win32 : path.posix).resolve(r.root, value), r.platform));
      if (!ok) return `${entry} may only use files inside the project folder in this app (${key}: ${String(value).slice(0, 200)}).`;
    }
  }
  return null;
}

// ------------------------------------------------------------- permissions

/**
 * The engine `permission` rules the MCP servers add in a permission mode
 * (the safety modes, OMNIRUSH_PERMISSION_MODE): Normal lets an allowed
 * server's tools run (`<id>_*: allow`) and asks before the ones that change
 * something (`<id>_<tool>: ask`, its entry's `write_tools`; with `read_tools`, it asks for every
 * tool but those); Careful asks
 * for every tool already and Auto for none, so they add nothing. The
 * engine takes the last rule that matches, so these go after the mode's own.
 */
export function mcpPermissionRules(decisions, mode) {
  if (String(mode ?? "").trim().toLowerCase() !== "normal") return {};
  const rules = {};
  for (const d of decisions ?? []) {
    if (!d || d.status !== "allowed" || !d.id) continue;
    if (Array.isArray(d.read_tools)) {
      rules[`${toolPrefix(d.id)}*`] = "ask";
      for (const tool of d.read_tools) rules[`${toolPrefix(d.id)}${String(tool).replace(/[^a-zA-Z0-9_-]/g, "_")}`] = "allow";
      continue;
    }
    if (!Array.isArray(d.write_tools)) {
      rules[`${toolPrefix(d.id)}*`] = "ask";
      continue;
    }
    rules[`${toolPrefix(d.id)}*`] = "allow";
    for (const tool of d.write_tools) rules[`${toolPrefix(d.id)}${String(tool).replace(/[^a-zA-Z0-9_-]/g, "_")}`] = "ask";
  }
  return rules;
}

/** `permission` with `rules` after its own (a string value becomes its "*" rule). */
function withRules(permission, rules) {
  if (!Object.keys(rules).length) return permission;
  const base = typeof permission === "string" ? { "*": permission } : isRecord(permission) ? { ...permission } : {};
  for (const key of Object.keys(rules)) delete base[key];
  return { ...base, ...rules };
}

// --------------------------------------------------------- the plugin's hooks

/** The policy the app wrote for the engine (`{v, policy, at}`); null: MCP off. */
export function readPolicyFile(file) {
  if (!file) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return value && value.v === MCP_POLICY_FILE_VERSION ? normalizePolicy(value.policy) : null;
  } catch {
    return null;
  }
}

/** Write the policy file the engine plugin reads (atomic). */
export function writePolicyFile(file, block, now = Date.now()) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: MCP_POLICY_FILE_VERSION, policy: isRecord(block) ? block : null, at: now }), { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

/** Where the plugin writes a project's report under `dir`. */
export function reportPath(dir, root) {
  return path.join(dir, `${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 24)}.json`);
}

/** A project's last report (`{v, root, at, decisions}`), or null. */
export function readReport(dir, root) {
  try {
    const value = JSON.parse(readFileSync(reportPath(dir, root), "utf8"));
    return value && value.v === MCP_POLICY_FILE_VERSION && Array.isArray(value.decisions) ? value : null;
  } catch {
    return null;
  }
}

/**
 * What the engine left out of the project's own config because it runs code
 * (`omnirush_ignored`, set by the engine with OMNIRUSH_PROJECT_CODE=0): its
 * plugins, and lsp / formatter entries that name a command.
 */
export function projectCodeIgnored(cfg) {
  const list = isRecord(cfg) && Array.isArray(cfg.omnirush_ignored) ? cfg.omnirush_ignored : [];
  return list
    .filter((x) => isRecord(x) && ["plugin", "lsp", "formatter", "provider"].includes(x.kind) && typeof x.name === "string")
    .slice(0, 50)
    .map((x) => ({ kind: x.kind, name: x.name.slice(0, 200), source: typeof x.source === "string" ? x.source.slice(0, 400) : null }));
}

/** One line for a notice: what of the project's own config did not load, and why; null when nothing. */
export function describeIgnored(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return null;
  const what = (kind) => list.filter((x) => x.kind === kind).map((x) => (kind === "plugin" ? path.basename(String(x.name).replace(/^file:\/\//, "")) : x.name));
  const parts = [];
  const plugins = what("plugin");
  const lsp = what("lsp");
  const fmt = what("formatter");
  const providers = what("provider");
  if (plugins.length) parts.push(`plugins ${plugins.slice(0, 3).join(", ")}${plugins.length > 3 ? " ..." : ""}`);
  if (lsp.length) parts.push(`language servers ${lsp.slice(0, 3).join(", ")}`);
  if (fmt.length) parts.push(`formatters ${fmt.slice(0, 3).join(", ")}`);
  if (providers.length) parts.push("model provider settings");
  return `Not loaded from this project's config: ${parts.join("; ")}. A project's own plugins, tools, commands and providers could run code just by opening it; the built-in language servers and formatters still work (some use the project's own installed copy), and your own (user-level) settings apply as usual.`;
}

/** One line per decision, for a terminal or a notice. */
export function describeDecision(d) {
  if (d.status === "allowed") {
    // The version is in the line already; the other notes say what the app changed.
    const notes = (d.notes ?? []).filter((n) => !n.startsWith("runs version "));
    const what = d.runtime === "remote" ? (d.url ? `, ${d.url}` : "") : d.version ? `, ${d.package}@${d.version}` : "";
    return `MCP ${d.id}${d.renamed_to && d.name !== d.id ? ` (${d.name})` : ""}: ${d.enabled === false ? "turned off" : "on"}${what}${notes.length ? ` (${notes.join("; ")})` : ""}`;
  }
  return `MCP ${d.name}: blocked. ${d.reason}`;
}

function configTarget(input, output) {
  if (isRecord(output) && (Object.hasOwn(output, "mcp") || !isRecord(input))) return output;
  return isRecord(input) ? input : isRecord(output) ? output : null;
}

/**
 * The engine plugin's hooks. `options`: `{directory, policyFile, reportDir,
 * box (null or a function of the root returning {shell, key, croot} or
 * null), npmPrefix (default: <reportDir>/../npx-prefix), permissionMode
 * (default: OMNIRUSH_PERMISSION_MODE; see mcpPermissionRules), platform,
 * now}`. The `config` hook replaces `mcp` with the allowed
 * servers (none without a readable policy); `tool.execute.before` refuses
 * non-local pages for `local_urls` servers and paths outside the project
 * for `path_inputs` servers.
 */
export function createMcpPolicyHooks(options = {}) {
  const root = path.resolve(options.directory || process.cwd());
  const state = { localOnly: [], pathInputs: [], roots: [] };
  const apply = (input, output) => {
    const target = configTarget(input, output);
    if (!target) return;
    const policy = readPolicyFile(options.policyFile);
    const box = typeof options.box === "function" ? options.box(root) : options.box ?? null;
    const npmPrefix = options.npmPrefix || (options.reportDir ? path.join(options.reportDir, "..", "npx-prefix") : path.join(os.homedir(), ".cache", "omnirush-mcp-npx"));
    if (!box) {
      try { mkdirSync(npmPrefix, { recursive: true }); } catch { /* npx makes it */ }
    }
    const { mcp, decisions } = evaluateMcp(target.mcp, policy, { root, platform: options.platform, box, npmPrefix, ...(options.resolveRunner ? { resolveRunner: options.resolveRunner } : {}) });
    target.mcp = mcp;
    const mode = typeof options.permissionMode === "function" ? options.permissionMode() : options.permissionMode ?? process.env.OMNIRUSH_PERMISSION_MODE;
    const rules = mcpPermissionRules(decisions, mode);
    if (Object.keys(rules).length) target.permission = withRules(target.permission, rules);
    const on = policy ? policy.allow.filter((e) => Object.hasOwn(mcp, e.id)) : [];
    state.localOnly = on.filter((e) => e.rules.local_urls).map((e) => e.id);
    state.pathInputs = on.filter((e) => e.rules.path_inputs).map((e) => ({ id: e.id, keys: e.rules.path_inputs }));
    const platform = options.platform || process.platform;
    state.roots = [{ root, platform }, ...(box && box.croot && box.croot !== root ? [{ root: box.croot, platform: "linux" }] : [])];
    if (options.reportDir) {
      try {
        const file = reportPath(options.reportDir, root);
        mkdirSync(options.reportDir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ v: MCP_POLICY_FILE_VERSION, root, at: (options.now ?? Date.now)(), enabled: Boolean(policy?.enabled), decisions, ignored: projectCodeIgnored(target) }), { mode: 0o600 });
        renameSync(tmp, file);
      } catch { /* the report is for display only */ }
    }
  };
  return {
    config: async (input, output) => {
      try {
        apply(input, output);
      } catch {
        // Never leave the engine's own list in place: no servers at all.
        const target = configTarget(input, output);
        if (target) target.mcp = {};
        state.localOnly = [];
        state.pathInputs = [];
      }
    },
    "tool.execute.before": async (input, output) => {
      const why = toolRefusal(state, input?.tool, output?.args ?? input?.args);
      if (why) throw new Error(why);
    },
  };
}
