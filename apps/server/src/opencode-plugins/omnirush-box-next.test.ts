import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BOX_HEADER } from "../model-modes/model-modes.mjs";
import { keyOf } from "../box/plugin-lib.js";
import plugin from "./omnirush-box-next.js";

type Hook = (event: any) => Promise<void>;
let dir = "";
let savedHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "box-next-"));
  savedHome = process.env.OMNIRUSH_BOX_HOME;
  process.env.OMNIRUSH_BOX_HOME = path.join(dir, "box");
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.OMNIRUSH_BOX_HOME;
  else process.env.OMNIRUSH_BOX_HOME = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

/** A project folder whose box the desktop lists (on) or not, with its running record. */
function project(on: boolean): { root: string; key: string } {
  const root = path.join(dir, "proj");
  mkdirSync(root, { recursive: true });
  const key = keyOf(root);
  mkdirSync(path.join(dir, "box", "boxes"), { recursive: true });
  writeFileSync(path.join(dir, "box", "boxes", `${key}.json`), JSON.stringify({ state: "running", uid: 0 }));
  writeFileSync(path.join(dir, "box", "desktop-projects.json"), JSON.stringify({ keys: on ? [key] : [], pkglog_dir: path.join(dir, "pkglog") }));
  return { root, key };
}

/** The 2.x plugin set up the way the engine does it: one instance per project folder. */
async function engine(root: string) {
  const hooks = new Map<string, Hook>();
  const hook = async (name: string, callback: Hook) => { hooks.set(name, callback); };
  await plugin.setup({
    location: { directory: root },
    session: { get: async () => ({ data: {} }), hook } as any,
    shell: { hook: (name: string, callback: Hook) => hook(`shell:${name}`, callback) } as any,
    tool: { hook: (name: string, callback: Hook) => hook(`tool:${name}`, callback) } as any,
  });
  return hooks;
}

test("a box chat's shell calls carry its box key and chat, its requests say box, the prompt names the sandbox", async () => {
  const { root, key } = project(true);
  const hooks = await engine(root);
  await hooks.get("tool:execute.before")!({ tool: "shell", id: "call_1", sessionID: "ses_a", input: { command: "hostname" } });
  const shell = { command: "hostname", cwd: root, env: { PATH: "/usr/bin" } as Record<string, string | undefined> };
  await hooks.get("shell:create.before")!(shell);
  // boxsh (the engine's shell) runs the command in the box named by OMNIRUSH_BOX_KEY.
  expect(shell.env).toMatchObject({ OMNIRUSH_BOX_KEY: key, OMNIRUSH_CALL: "call_1", OMNIRUSH_SESSION: "ses_a", PATH: "/usr/bin" });
  const request = { sessionID: "ses_a", headers: {} as Record<string, string> };
  await hooks.get("model.request")!(request);
  expect(request.headers[BOX_HEADER]).toBe("1");
  const context = { sessionID: "ses_a", system: ["Platform: darwin", { type: "text", text: "rules" }] as unknown[] };
  await hooks.get("context")!(context);
  expect(context.system[0]).toBe("Platform: linux");
  expect(context.system[1]).toEqual({ type: "text", text: "rules" });
  expect(JSON.stringify(context.system.at(-1))).toContain("Sandbox: shell commands run in a Linux");
  // File tools stay in the project folder: the rest is the box's.
  await expect(hooks.get("tool:execute.before")!({ tool: "read", id: "call_2", sessionID: "ses_a", input: { filePath: "/etc/hostname" } })).rejects.toThrow(/outside the project folder/);
});

test("a project whose box is off is left alone: no box key, no box header, no note", async () => {
  const { root } = project(false);
  const hooks = await engine(root);
  await hooks.get("tool:execute.before")!({ tool: "shell", id: "call_1", sessionID: "ses_b", input: { command: "hostname" } });
  const shell = { command: "hostname", cwd: root, env: {} as Record<string, string | undefined> };
  await hooks.get("shell:create.before")!(shell);
  expect(shell.env.OMNIRUSH_BOX_KEY).toBeUndefined();
  const request = { sessionID: "ses_b", headers: {} as Record<string, string> };
  await hooks.get("model.request")!(request);
  expect(request.headers[BOX_HEADER]).toBeUndefined();
  const context = { sessionID: "ses_b", system: ["Platform: darwin"] as unknown[] };
  await hooks.get("context")!(context);
  expect(context.system).toEqual(["Platform: darwin"]);
});
