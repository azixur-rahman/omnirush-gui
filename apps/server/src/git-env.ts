/**
 * The environment every git the desktop server starts gets. Git runs the repository's hooks (a commit runs
 * pre-commit, commit-msg …), and a hook is the repository's code: it must not see the app's tokens, the engine's
 * password or the person's other keys. So git gets what a local MCP server gets (mcpServerEnvironment: PATH, HOME,
 * locale, temp folders, proxy / certificate / registry settings) plus git's own settings that carry no credential
 * (who commits, which certificates to trust, which config files to read, the GnuPG folder and the ssh-agent socket
 * for signed commits).
 * Variables that point git at another repository (GIT_DIR, GIT_WORK_TREE …) are never passed.
 */
import { mcpServerEnvironment } from "./mcp-allow/mcp-allow.mjs";

const GIT_KEEP = /^(?:GIT_AUTHOR_(?:NAME|EMAIL|DATE)|GIT_COMMITTER_(?:NAME|EMAIL|DATE)|GIT_SSL_CAINFO|GIT_SSL_CAPATH|GIT_CONFIG_NOSYSTEM|GIT_CONFIG_GLOBAL|GIT_CEILING_DIRECTORIES|GNUPGHOME|GPG_TTY|SSH_AUTH_SOCK)$/;

export function gitChildEnv(extra: Record<string, string> = {}, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const cleared = mcpServerEnvironment(env, {}, [], platform);
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    if (/^GIT_/i.test(key) ? GIT_KEEP.test(key) : !Object.hasOwn(cleared, key) || GIT_KEEP.test(key)) out[key] = value;
  }
  return { ...out, GIT_TERMINAL_PROMPT: "0", ...extra };
}
