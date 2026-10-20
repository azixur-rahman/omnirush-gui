// Types of mcp-allow.mjs (the same pair of files in omnirush-cli src/mcp/ and
// omnirush-gui apps/server/src/mcp-allow/; PARITY.sha256).

export const MCP_POLICY_FILE_VERSION: 1;
export const BOX_NPM_PREFIX: string;
export const MCP_REASONS: Record<McpDecisionCode, string>;

export type McpRuntime = "npm" | "pypi" | "remote";
export type McpDecisionCode =
  | "allowed" | "disabled" | "remote" | "unknown_command" | "not_allowed" | "denied"
  | "version" | "outside_project" | "missing_flag" | "missing_arg" | "flag" | "duplicate" | "invalid" | "runner_missing" | "secret_missing" | "remote_settings";

export type McpRules = {
  path_args?: "positional";
  min_args?: number;
  default_args?: string[];
  path_flags?: string[];
  require_flags?: string[];
  add_flags?: string[];
  forbid_flags?: string[];
  /** When set, the only flags the server may be given (add_flags are the app's own). */
  allow_flags?: string[];
  path_env?: Record<string, string>;
  local_urls?: boolean;
  path_inputs?: string[];
  /** Variables read only from the person's own environment (one must be set). */
  secret_env?: string[];
  /** Flags whose value must be one of these. */
  flag_values?: Record<string, string[]>;
};

export type McpAllowEntry = {
  id: string;
  runtime: McpRuntime;
  package: string;
  bins: string[];
  versions: string;
  pin: string | null;
  title: string;
  why: string | null;
  /** Setup hint shown with the preset. */
  setup: string | null;
  /** runtime "remote": the exact address, and whether the engine signs in with OAuth. */
  url?: string;
  oauth?: boolean;
  /** null: not listed, every tool counts as one that changes something. */
  write_tools: string[] | null;
  read_tools: string[] | null;
  rules: McpRules;
};

export type McpPolicy = {
  enabled: boolean;
  allow: McpAllowEntry[];
  deny: Array<{ match: string; reason: string | null }>;
  message: string | null;
};

export type McpDecision = {
  name: string;
  status: "allowed" | "blocked";
  code: McpDecisionCode;
  reason?: string;
  id?: string;
  package?: string;
  runtime?: McpRuntime;
  title?: string;
  version?: string;
  sandbox?: boolean;
  /** Allowed entries: false when the user turned the server off (`enabled: false`). */
  enabled?: boolean;
  renamed_to?: string;
  url_host?: string | null;
  url?: string;
  oauth?: boolean;
  write_tools?: string[] | null;
  read_tools?: string[] | null;
  notes?: string[];
};

export type McpBox = { shell: string; key: string; croot?: string | null };

export type McpIgnored = { kind: "plugin" | "lsp" | "formatter" | "provider"; name: string; source: string | null };
export type McpReport = { v: 1; root: string; at: number; enabled: boolean; decisions: McpDecision[]; ignored?: McpIgnored[] };

export type McpLaunch = {
  runtime: McpRuntime;
  name: string;
  version: string | null;
  bin: string | null;
  specIndex: number;
  rest: string[];
  restIndex: number;
  /** The runner the config named (npx, bunx, pnpm, yarn, npm, uvx, uv). */
  runner: string;
};

export function versionParts(value: unknown): number[] | null;
export function versionInRange(version: unknown, range: unknown): boolean;
export function validRange(range: unknown): boolean;
export function normalizePolicy(block: unknown): McpPolicy | null;
export function splitSpec(spec: string, runtime: McpRuntime): { name: string; version: string | null } | null;
export function parseLaunch(command: unknown): McpLaunch | null;
export function launchCommand(entry: McpAllowEntry, launch: McpLaunch, version: string, npmPrefix: string): string[];
export function windowsDirect(found: string, platform?: string, exists?: (file: string) => boolean): string[] | null;
export function normalizeRemoteUrl(value: unknown): string | null;
export function resolveRunner(runner: string, options?: { root?: string | null; platform?: string; env?: Record<string, string | undefined>; exists?: (file: string) => boolean; home?: string; accept?: ((file: string) => boolean) | null }): string | null;
export function projectCodeIgnored(cfg: unknown): McpIgnored[];
export function describeIgnored(items: McpIgnored[] | null | undefined): string | null;
export function insideRoot(root: string, p: string, platform?: string): boolean;
export function insideRootReal(root: string, p: string, platform?: string): boolean;
export function shellQuote(word: string): string;
/** The engine variables allowed through to a local MCP server (the rest are set empty for it). */
export const MCP_ENV_ALLOW: readonly string[];
/** The `environment` a local MCP server gets: `own`, every other engine variable empty except the basics and `keep`. */
export function mcpServerEnvironment(engineEnv: Record<string, string | undefined> | undefined, own?: Record<string, string>, keep?: string[], platform?: string): Record<string, string>;
export function evaluateMcp(
  mcpMap: unknown,
  policy: McpPolicy | null,
  ctx?: { root?: string; platform?: string; box?: McpBox | null; npmPrefix?: string; resolveRunner?: (runner: string, options: { root: string; platform: string; accept?: (file: string) => boolean }) => string | null; exists?: (file: string) => boolean; env?: Record<string, string | undefined> },
): { mcp: Record<string, Record<string, unknown>>; decisions: McpDecision[] };
export function toolPrefix(name: string): string;
export function mcpPermissionRules(decisions: McpDecision[] | null | undefined, mode: unknown): Record<string, "allow" | "ask">;
export function toolRefusal(
  state: { localOnly?: string[]; pathInputs?: Array<{ id: string; keys: string[] }>; roots?: Array<{ root: string; platform: string }> },
  tool: unknown,
  args: unknown,
): string | null;
export function readPolicyFile(file: string | null | undefined): McpPolicy | null;
export function writePolicyFile(file: string, block: unknown, now?: number): string;
export function reportPath(dir: string, root: string): string;
export function readReport(dir: string, root: string): McpReport | null;
export function describeDecision(d: McpDecision): string;
export function createMcpPolicyHooks(options?: {
  directory?: string;
  policyFile?: string | null;
  reportDir?: string | null;
  box?: McpBox | null | ((root: string) => McpBox | null);
  npmPrefix?: string;
  resolveRunner?: (runner: string, options: { root: string; platform: string; accept?: (file: string) => boolean }) => string | null;
  permissionMode?: string | null | (() => string | null | undefined);
  platform?: string;
  now?: () => number;
}): {
  config: (input: unknown, output?: unknown) => Promise<void>;
  "tool.execute.before": (input: { tool?: unknown; args?: unknown }, output?: { args?: unknown }) => Promise<void>;
};
