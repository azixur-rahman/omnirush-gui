// 2.x engine plugin ({id, setup(ctx)}): the box plugin (omnirush-box.ts, a 1.x
// hook object, kept in step with the CLI's) on the 2.x plugin API, as the
// CLI's bridge plugin (omnirush-cli assets/engine-v2-plugin) registers it:
//   shell.env                          -> shell "create.before" (env)
//   tool.execute.before                -> tool "execute.before"
//   chat.headers                       -> session "model.request" (headers)
//   experimental.chat.system.transform -> session "context" (system parts)
// The engine's shell is the box shell (opencode.json `shell`); a project
// whose box is off is left alone by the box plugin itself.

import { OmniRushBox } from "./omnirush-box.js";

export const OMNIRUSH_BOX_PLUGIN_ID = "omnirush.box";

type ShellEvent = { command?: string; cwd?: string; env: Record<string, string | undefined> };
type ToolEvent = { tool: string; id?: string; sessionID?: string; input?: unknown };
type HeadersEvent = { sessionID: string; headers: Record<string, string> };
type ContextEvent = { sessionID: string; model?: unknown; system?: unknown };
type Ctx = {
  location?: { directory?: string };
  session: {
    get(input: { sessionID: string }): Promise<unknown>;
    hook(name: "model.request", callback: (event: HeadersEvent) => Promise<void>): Promise<unknown>;
    hook(name: "context", callback: (event: ContextEvent) => Promise<void>): Promise<unknown>;
  };
  shell: { hook(name: "create.before", callback: (event: ShellEvent) => Promise<void>): Promise<unknown> };
  tool: { hook(name: "execute.before", callback: (event: ToolEvent) => Promise<void>): Promise<unknown> };
};

/** A system part's text (a string or { type: "text", text }), else null. */
function systemText(part: unknown): string | null {
  if (typeof part === "string") return part;
  return part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : null;
}

export default {
  id: OMNIRUSH_BOX_PLUGIN_ID,
  async setup(ctx: Ctx) {
    // The 1.x client call the box plugin makes: a chat's parent (sub-agents keep their top chat's box).
    const client = {
      session: {
        get: async ({ path: where }: { path: { id: string } }) => {
          const found = await ctx.session.get({ sessionID: where.id }) as { data?: unknown } | undefined;
          const info = (found && typeof found === "object" && "data" in found ? found.data : found) as { parentID?: string } | null | undefined;
          return { data: info ?? null };
        },
      },
    };
    const hooks = await OmniRushBox({ directory: ctx.location?.directory ?? process.cwd(), client });
    // The 2.x shell hook names no call: execute.before sees the shell call (and its chat) first.
    // shortcut: keyed by command text, two identical commands at once share one id; upgrade when 2.x passes the call id.
    const calls = new Map<string, { callID: string; sessionID: string }>();

    await ctx.tool.hook("execute.before", async (event) => {
      const args = (event.input && typeof event.input === "object" ? event.input : {}) as Record<string, unknown>;
      if (event.tool === "shell" && typeof args.command === "string") {
        calls.set(args.command, { callID: String(event.id ?? ""), sessionID: String(event.sessionID ?? "") });
        if (calls.size > 256) calls.delete(calls.keys().next().value as string);
      }
      await hooks["tool.execute.before"]({ tool: event.tool, sessionID: event.sessionID }, { args });
      event.input = args;
    });

    await ctx.shell.hook("create.before", async (event) => {
      const { callID, sessionID } = calls.get(event.command ?? "") ?? { callID: "", sessionID: "" };
      const output = { env: event.env as Record<string, string> };
      await hooks["shell.env"]({ callID, sessionID }, output);
      event.env = output.env;
    });

    await ctx.session.hook("model.request", async (event) => {
      await hooks["chat.headers"]({ sessionID: event.sessionID }, { headers: event.headers });
    });

    await ctx.session.hook("context", async (event) => {
      if (!Array.isArray(event.system)) return;
      const parts = event.system as unknown[];
      const output = { system: parts.map(systemText).filter((text): text is string => text !== null) };
      const before = output.system.length;
      await hooks["experimental.chat.system.transform"]({ sessionID: event.sessionID }, output);
      let i = 0;
      event.system = parts.map((part) => {
        if (systemText(part) === null) return part;
        const text = output.system[i++];
        return typeof part === "string" ? text : { ...(part as object), text };
      });
      for (const extra of output.system.slice(before)) (event.system as unknown[]).push({ type: "text", text: extra });
    });
  },
};
