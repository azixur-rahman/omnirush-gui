import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import omnirushMcpPolicy from "../opencode-plugins/omnirush-mcp-policy.js";
import { keyOf } from "../box/plugin-lib.js";
import { describeIgnored, evaluateMcp, mcpServerEnvironment, normalizePolicy, readPolicyFile } from "./mcp-allow.mjs";
import {
  decideMcpEntry,
  mcpEngineEnv,
  mcpPolicyEnabled,
  mcpServersInUse,
  readWorkspaceMcp,
  rememberMcpPolicy,
  workspaceMcpReport,
  writeWorkspaceMcp,
} from "./state.js";
import policyFixture from "./mcp-policy.fixture.json" with { type: "json" };

const dirs: string[] = [];
const saved = { ...process.env };
function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of ["OMNIRUSH_MCP_POLICY_FILE", "OMNIRUSH_MCP_REPORT_DIR", "OMNIRUSH_MCP_WORKSPACE_DIR", "OMNIRUSH_BOX_HOME", "PATH"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const FILESYSTEM = { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."], enabled: true };

describe("the remembered MCP list", () => {
  test("is off until seen, follows each answer, and keeps the last one when no answer came", () => {
    const state = temp("mcp-state-");
    expect(mcpPolicyEnabled(state)).toBe(false);
    expect(rememberMcpPolicy(state, null)).toBe(false);
    expect(rememberMcpPolicy(state, { mcp: policyFixture })).toBe(true);
    expect(rememberMcpPolicy(state, { mcp: policyFixture })).toBe(false);
    expect(mcpPolicyEnabled(state)).toBe(true);
    expect(readPolicyFile(mcpEngineEnv(state).OMNIRUSH_MCP_POLICY_FILE)?.allow.map((entry) => entry.id)).toContain("filesystem");
    // A failed read says nothing: the last list stays.
    expect(rememberMcpPolicy(state, undefined)).toBe(false);
    expect(mcpPolicyEnabled(state)).toBe(true);
    // A backend that sends no block: MCP off.
    expect(rememberMcpPolicy(state, { schema_versions: [1, 2] } as { mcp?: unknown })).toBe(true);
    expect(mcpPolicyEnabled(state)).toBe(false);
  });

  test("the engine never takes plugins or commands from a project's config, unless the app itself says so", () => {
    const state = temp("mcp-state-");
    expect(mcpEngineEnv(state, {}).OMNIRUSH_PROJECT_CODE).toBe("0");
    expect(mcpEngineEnv(state, { OMNIRUSH_PROJECT_CODE: "true" }).OMNIRUSH_PROJECT_CODE).toBe("0");
    expect(mcpEngineEnv(state, { OMNIRUSH_PROJECT_CODE: "1" }).OMNIRUSH_PROJECT_CODE).toBe("1");
  });

  test("decides one entry before it is saved", () => {
    const state = temp("mcp-state-");
    const root = temp("mcp-root-");
    expect(decideMcpEntry(state, root, "filesystem", FILESYSTEM)).toMatchObject({ status: "blocked", code: "disabled" });
    rememberMcpPolicy(state, { mcp: policyFixture });
    expect(decideMcpEntry(state, root, "filesystem", FILESYSTEM)).toMatchObject({ status: "allowed", id: "filesystem", version: "2026.8.31" });
    expect(decideMcpEntry(state, root, "gh", { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-github"] })).toMatchObject({ status: "blocked", code: "denied" });
    expect(decideMcpEntry(state, root, "notion", { type: "remote", url: "https://mcp.notion.com/mcp" })).toMatchObject({ status: "blocked", code: "remote" });
  });

  test("a project's app-added entries round-trip, and none removes the file", () => {
    const state = temp("mcp-state-");
    const root = temp("mcp-root-");
    expect(writeWorkspaceMcp(state, root, { filesystem: FILESYSTEM })).toBe(true);
    expect(writeWorkspaceMcp(state, root, { filesystem: FILESYSTEM })).toBe(false);
    expect(readWorkspaceMcp(mcpEngineEnv(state).OMNIRUSH_MCP_WORKSPACE_DIR, root)).toEqual({ filesystem: FILESYSTEM });
    expect(writeWorkspaceMcp(state, root, {})).toBe(true);
    expect(readWorkspaceMcp(mcpEngineEnv(state).OMNIRUSH_MCP_WORKSPACE_DIR, root)).toEqual({});
  });
});

describe("the engine plugin (omnirush-mcp-policy)", () => {
  function setup() {
    const state = temp("mcp-state-");
    const root = temp("mcp-root-");
    const env = mcpEngineEnv(state);
    Object.assign(process.env, env);
    process.env.OMNIRUSH_BOX_HOME = path.join(state, "box-home");
    // The runners resolve to absolute paths on PATH, outside the project.
    const bin = temp("mcp-bin-");
    for (const name of ["npx", "uvx"]) writeFileSync(path.join(bin, process.platform === "win32" ? `${name}.cmd` : name), "", { mode: 0o755 });
    process.env.PATH = bin;
    return { state, root, bin };
  }

  test("without a list: no MCP at all, and the session environment gets no field", async () => {
    const { state, root } = setup();
    const hooks = await omnirushMcpPolicy({ directory: root });
    const output = { mcp: { filesystem: FILESYSTEM } } as Record<string, unknown>;
    await hooks.config({}, output);
    expect(output.mcp).toEqual({});
    const report = workspaceMcpReport(state, root);
    expect(report?.enabled).toBe(false);
    expect(report?.decisions[0]).toMatchObject({ name: "filesystem", status: "blocked", code: "disabled" });
    expect(mcpServersInUse(report)).toBeNull();
  });

  test("with the list: config and app-added entries are filtered, renamed to their id and pinned", async () => {
    const { state, root, bin } = setup();
    rememberMcpPolicy(state, { mcp: policyFixture });
    writeWorkspaceMcp(state, root, { files: FILESYSTEM, notion: { type: "remote", url: "https://mcp.notion.com/mcp" } });
    const hooks = await omnirushMcpPolicy({ directory: root });
    const output = { mcp: { time: { type: "local", command: ["uvx", "mcp-server-time"] }, script: { type: "local", command: ["node", "server.js"] } } } as Record<string, unknown>;
    await hooks.config({}, output);
    const mcp = output.mcp as Record<string, { command: string[] }>;
    expect(Object.keys(mcp).sort()).toEqual(["filesystem", "time"]);
    const runner = (name: string) => path.join(bin, process.platform === "win32" ? `${name}.cmd` : name);
    const npx = [runner("npx"), "--prefix", path.join(process.env.OMNIRUSH_MCP_REPORT_DIR!, "..", "npx-prefix"), "-y"];
    expect(mcp.filesystem!.command).toEqual([...npx, "@modelcontextprotocol/server-filesystem@2026.8.31", "."]);
    expect(mcp.time!.command).toEqual([runner("uvx"), "--no-config", "mcp-server-time@2026.8.18"]);
    const report = workspaceMcpReport(state, root);
    const byName = Object.fromEntries((report?.decisions ?? []).map((decision) => [decision.name, decision]));
    expect(byName.script).toMatchObject({ status: "blocked", code: "unknown_command" });
    expect(byName.notion).toMatchObject({ status: "blocked", code: "remote" });
    expect(byName.files).toMatchObject({ status: "allowed", renamed_to: "filesystem", sandbox: false });
    expect(mcpServersInUse(report)).toEqual([
      { id: "time", package: "mcp-server-time", version: "2026.8.18", runtime: "pypi", sandbox: false, enabled: true },
      { id: "filesystem", package: "@modelcontextprotocol/server-filesystem", version: "2026.8.31", runtime: "npm", sandbox: false, enabled: true },
    ]);
  });

  test("a server the user turned off is listed, marked enabled: false", async () => {
    const { state, root } = setup();
    rememberMcpPolicy(state, { mcp: policyFixture });
    writeWorkspaceMcp(state, root, { files: { ...FILESYSTEM, enabled: false } });
    const hooks = await omnirushMcpPolicy({ directory: root });
    const output = { mcp: {} } as Record<string, unknown>;
    await hooks.config({}, output);
    const report = workspaceMcpReport(state, root);
    expect(report?.decisions[0]?.enabled).toBe(false);
    expect(mcpServersInUse(report)).toEqual([{ id: "filesystem", package: "@modelcontextprotocol/server-filesystem", version: "2026.8.31", runtime: "npm", sandbox: false, enabled: false }]);
  });

  test("no npx outside the project: the server is blocked, never started from the project", async () => {
    const { state, root } = setup();
    rememberMcpPolicy(state, { mcp: policyFixture });
    const empty = temp("mcp-nobin-");
    // A runner planted in the project is never used.
    writeFileSync(path.join(root, "npx"), "", { mode: 0o755 });
    process.env.PATH = `${root}${path.delimiter}${empty}`;
    const hooks = await omnirushMcpPolicy({ directory: root });
    const output = { mcp: { filesystem: FILESYSTEM } } as Record<string, unknown>;
    await hooks.config({}, output);
    expect(output.mcp).toEqual({});
    expect(workspaceMcpReport(state, root)?.decisions[0]).toMatchObject({ name: "filesystem", status: "blocked", code: "runner_missing" });
  });

  test("the report lists what the engine left out of the project's config", async () => {
    const { state, root } = setup();
    const hooks = await omnirushMcpPolicy({ directory: root });
    const ignored = [{ kind: "plugin", name: "file:///repo/.opencode/plugins/evil.ts", source: "/repo/.opencode/plugins" }, { kind: "lsp", name: "custom", source: "/repo/opencode.json" }, { kind: "provider", name: "provider", source: "/repo/opencode.json" }];
    await hooks.config({}, { mcp: {}, omnirush_ignored: ignored });
    const report = workspaceMcpReport(state, root);
    expect(report?.ignored?.map((item) => item.kind)).toEqual(["plugin", "lsp", "provider"]);
    expect(describeIgnored(report?.ignored)).toContain("Not loaded from this project's config: plugins evil.ts; language servers custom; model provider settings.");
    // The desktop shows this line as it is (GET /workspace/:id/mcp ignoredNotice): no path that only fits the CLI.
    expect(describeIgnored(report?.ignored)).toContain("your own (user-level) settings");
  });

  test("a project whose sandbox is on runs its servers through the box shell", async () => {
    const { state, root } = setup();
    rememberMcpPolicy(state, { mcp: policyFixture });
    const home = process.env.OMNIRUSH_BOX_HOME!;
    const key = keyOf(root);
    mkdirSync(path.join(home, "boxes"), { recursive: true });
    mkdirSync(path.join(home, "shell"), { recursive: true });
    writeFileSync(path.join(home, "desktop-projects.json"), JSON.stringify({ keys: [key] }));
    writeFileSync(path.join(home, "boxes", `${key}.json`), JSON.stringify({ state: "running", croot: "/work" }));
    writeFileSync(path.join(home, "shell", process.platform === "win32" ? "bash.exe" : "bash"), "");
    const hooks = await omnirushMcpPolicy({ directory: root });
    const output = { mcp: { filesystem: FILESYSTEM } } as Record<string, unknown>;
    await hooks.config({}, output);
    const entry = (output.mcp as Record<string, { command: string[]; environment: Record<string, string> }>).filesystem!;
    expect(entry.command[0]).toBe(path.join(home, "shell", process.platform === "win32" ? "bash.exe" : "bash"));
    expect(entry.command.slice(1)).toEqual(["-c", "mkdir -p /tmp/omnirush-mcp-npx && exec npx --prefix /tmp/omnirush-mcp-npx -y @modelcontextprotocol/server-filesystem@2026.8.31 ."]);
    // Its box key, and every other engine variable empty for it (mcpServerEnvironment).
    expect(entry.environment.OMNIRUSH_BOX_KEY).toBe(key);
    expect(Object.entries(entry.environment).filter(([name, value]) => !name.startsWith("OMNIRUSH_BOX_") && value !== "" && !["PATH", "HOME"].includes(name.toUpperCase()))).toEqual([]);
    expect(mcpServersInUse(workspaceMcpReport(state, root))?.[0]?.sandbox).toBe(true);
  });

  test("playwright refuses pages away from this machine", async () => {
    const { state, root } = setup();
    rememberMcpPolicy(state, { mcp: policyFixture });
    const hooks = await omnirushMcpPolicy({ directory: root });
    await hooks.config({}, { mcp: { playwright: { type: "local", command: ["npx", "@playwright/mcp"] } } });
    await expect(hooks["tool.execute.before"]({ tool: "playwright_browser_navigate" }, { args: { url: "https://example.com" } })).rejects.toThrow(/this machine only/);
    await hooks["tool.execute.before"]({ tool: "playwright_browser_navigate" }, { args: { url: "http://localhost:3000" } });
    // Other tools are untouched.
    await hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "curl https://example.com" } });
    const reports = mcpEngineEnv(state).OMNIRUSH_MCP_REPORT_DIR;
    expect(readFileSync(path.join(reports, readdirSync(reports)[0] ?? ""), "utf8")).toContain("playwright");
  });
});

describe("MCP server environment", () => {
  test("the app's tokens, the engine's password and other keys are empty for a server; the basics stay", () => {
    const policy = normalizePolicy(policyFixture);
    const engineEnv = {
      PATH: "/usr/bin", HOME: "/home/u", LANG: "C.UTF-8", LC_ALL: "C", HTTPS_PROXY: "http://proxy:3128",
      OMNIRUSH_ACCESS_TOKEN: "engine-token", OMNIRUSH_SERVER_TOKEN: "server-token", OMNIRUSH_POLICY_TOKEN: "policy-token",
      OPENCODE_SERVER_PASSWORD: "pw", OPENCODE_SERVER_USERNAME: "u", AWS_SECRET_ACCESS_KEY: "aws", GITHUB_TOKEN: "gh", NODE_OPTIONS: "--require /tmp/x.js",
    };
    const { mcp } = evaluateMcp({ filesystem: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."] } }, policy,
      { root: "/work/app", platform: "linux", npmPrefix: "/state/npx", resolveRunner: (runner: string) => runner, env: engineEnv });
    const environment = (mcp as Record<string, { environment?: Record<string, string> }>).filesystem!.environment!;
    for (const secret of ["OMNIRUSH_ACCESS_TOKEN", "OMNIRUSH_SERVER_TOKEN", "OMNIRUSH_POLICY_TOKEN", "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "NODE_OPTIONS"]) {
      expect([secret, environment[secret]]).toEqual([secret, ""]);
    }
    for (const basic of ["PATH", "HOME", "LANG", "LC_ALL", "HTTPS_PROXY"]) expect(environment).not.toHaveProperty(basic);
  });

  test("a protected name stays empty even when a server's rules name it; the rules drop such names", () => {
    expect(mcpServerEnvironment({ OMNIRUSH_ACCESS_TOKEN: "t", PATH: "/usr/bin" }, { OMNIRUSH_ACCESS_TOKEN: "/work/app/x", MEMORY_FILE_PATH: "/work/app/m" }, ["OPENCODE_SERVER_PASSWORD"], "linux"))
      .toEqual({ OMNIRUSH_ACCESS_TOKEN: "", MEMORY_FILE_PATH: "/work/app/m" });
    const block = JSON.parse(JSON.stringify(policyFixture)) as { allow: Array<{ rules?: Record<string, unknown> }> };
    block.allow[0]!.rules = { ...(block.allow[0]!.rules ?? {}), path_env: { OMNIRUSH_ACCESS_TOKEN: "x", MEMORY_FILE_PATH: "m.jsonl" }, secret_env: ["OMNIRUSH_SERVER_TOKEN", "SOME_API_KEY"] };
    const rules = normalizePolicy(block)!.allow[0]!.rules as { path_env?: Record<string, string>; secret_env?: string[] };
    expect(rules.path_env).toEqual({ MEMORY_FILE_PATH: "m.jsonl" });
    expect(rules.secret_env).toEqual(["SOME_API_KEY"]);
  });

  test("a sandboxed server's box shell keeps its own box settings, and its key", () => {
    const policy = normalizePolicy(policyFixture);
    const env = { OMNIRUSH_BOX_HOME: "/custom/box-home", OMNIRUSH_BOX_TIMING_LOG: "/tmp/t.log", OMNIRUSH_ACCESS_TOKEN: "t", PATH: "/usr/bin" };
    const { mcp } = evaluateMcp({ filesystem: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."] } }, policy,
      { root: "/work/app", platform: "linux", npmPrefix: "/state/npx", resolveRunner: (runner: string) => runner, env, box: { shell: "/custom/box-home/shell/bash", key: "k1", croot: "/workspace/app" } });
    const environment = (mcp as Record<string, { environment?: Record<string, string> }>).filesystem!.environment!;
    expect(environment).toMatchObject({ OMNIRUSH_BOX_HOME: "/custom/box-home", OMNIRUSH_BOX_TIMING_LOG: "/tmp/t.log", OMNIRUSH_BOX_KEY: "k1", OMNIRUSH_ACCESS_TOKEN: "" });
  });

  test("a server keeps the desktop session, git, Volta and registry settings; git logins and absent names are never set", () => {
    const env: Record<string, string | undefined> = {
      DISPLAY: ":99", WAYLAND_DISPLAY: "wayland-0", XAUTHORITY: "/home/u/.Xauthority", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", PLAYWRIGHT_BROWSERS_PATH: "/p",
      GIT_AUTHOR_NAME: "A", GIT_COMMITTER_EMAIL: "a@example.com", GIT_SSH_COMMAND: "ssh -i k", GIT_CONFIG_GLOBAL: "/g", GIT_SSL_CAINFO: "/ca", VOLTA_HOME: "/v",
      UV_INDEX: "u", UV_EXTRA_INDEX_URL: "u", UV_INSECURE_HOST: "h", CURL_CA_BUNDLE: "/ca", PIP_CERT: "/ca", NPM_CONFIG_USERCONFIG: "/n",
      GIT_ASKPASS: "/h", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: "Authorization: x", GIT_CONFIG_PARAMETERS: "x", GIT_HTTP_EXTRAHEADER: "x", GIT_CREDENTIAL_HELPER: "s", GIT_TOKEN: "x",
      UV_PUBLISH_TOKEN: "x", OMNIRUSH_ACCESS_TOKEN: "t", OPENCODE_SERVER_PASSWORD: "p", EMPTY_ONE: "", UNSET_ONE: undefined,
    };
    const out = mcpServerEnvironment(env, {}, [], "linux");
    expect(Object.keys(out).sort()).toEqual(["GIT_ASKPASS", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_VALUE_0", "GIT_CREDENTIAL_HELPER", "GIT_HTTP_EXTRAHEADER", "GIT_TOKEN", "OMNIRUSH_ACCESS_TOKEN", "OPENCODE_SERVER_PASSWORD", "UV_PUBLISH_TOKEN"]);
    expect(new Set(Object.values(out))).toEqual(new Set([""]));
  });

  test("Windows: a server's own variable wins over the engine's whatever the case", () => {
    expect(mcpServerEnvironment({ memory_file_path: "C:\\other" }, { MEMORY_FILE_PATH: "C:\\work\\m" }, [], "win32")).toEqual({ MEMORY_FILE_PATH: "C:\\work\\m" });
  });

  test("Windows: mixed-case names are matched whatever their case", () => {
    expect(mcpServerEnvironment({ Path: "C:\\Windows", SystemRoot: "C:\\Windows", Omnirush_Access_Token: "t", opencode_server_password: "p", Aws_Secret: "a" }, {}, [], "win32"))
      .toEqual({ Omnirush_Access_Token: "", opencode_server_password: "", Aws_Secret: "" });
  });

  test("a server's own key (secret_env) stays; Windows names match whatever their case", () => {
    expect(mcpServerEnvironment({ FIGMA_API_KEY: "k", OMNIRUSH_ACCESS_TOKEN: "t", OTHER_KEY: "o" }, { FRAMELINK_TELEMETRY: "off" }, ["FIGMA_API_KEY", "OMNIRUSH_ACCESS_TOKEN"], "linux"))
      .toEqual({ OMNIRUSH_ACCESS_TOKEN: "", OTHER_KEY: "", FRAMELINK_TELEMETRY: "off" });
    expect(mcpServerEnvironment({ Path: "C:\\Windows", SystemRoot: "C:\\Windows", OMNIRUSH_ACCESS_TOKEN: "t" }, {}, [], "win32")).toEqual({ OMNIRUSH_ACCESS_TOKEN: "" });
  });
});
