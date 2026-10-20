import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitChildEnv } from "./git-env.js";
import { runEditorGit } from "./routes/editor.js";
import { runGit } from "./workspace/worktree-tasks.mjs";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

test("the git environment keeps the basics and git's own settings, nothing else", () => {
  const env = gitChildEnv({ LC_ALL: "C" }, {
    PATH: "/usr/bin", HOME: "/home/u", LANG: "C.UTF-8", OMNIRUSH_TOKEN: "t", OMNIRUSH_DEVICE_TOKEN: "d", OPENCODE_SERVER_PASSWORD: "p",
    GITHUB_TOKEN: "g", AWS_SECRET_ACCESS_KEY: "a", NODE_OPTIONS: "--require x", GIT_DIR: "/elsewhere", GIT_AUTHOR_NAME: "Sam",
    GIT_SSL_CAINFO: "/ca.pem", GNUPGHOME: "/g", GIT_ASKPASS: "/x",
  }, "linux");
  expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u", LANG: "C.UTF-8", GIT_AUTHOR_NAME: "Sam", GIT_SSL_CAINFO: "/ca.pem", GNUPGHOME: "/g", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });
});

for (const [name, commit] of [
  ["the editor's git panel", (root: string) => runEditorGit(root, ["commit", "-q", "-F", "-"], { input: "test\n" })],
  ["workspace tasks", (root: string) => runGit(["commit", "-q", "-F", "-"], { cwd: root, input: "test\n" })],
] as const) test(`${name}: a commit's pre-commit hook runs, and sees no app tokens or other keys`, async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "omnirush-git-env-"));
  dirs.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } });
  git("init", "-q");
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.invalid");
  writeFileSync(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nenv | cut -d= -f1 | sort > \"$(git rev-parse --git-dir)/hook-env-names\"\n");
  chmodSync(join(root, ".git", "hooks", "pre-commit"), 0o755);
  writeFileSync(join(root, "a.txt"), "a\n");
  git("add", "a.txt");
  const saved = { ...process.env };
  Object.assign(process.env, { OMNIRUSH_TOKEN: "secret-token", OMNIRUSH_HOST_TOKEN: "secret-host", OPENCODE_SERVER_PASSWORD: "secret-pw", GITHUB_TOKEN: "secret-gh", AWS_SECRET_ACCESS_KEY: "secret-aws" });
  try {
    const result = await commit(root);
    expect(result.code).toBe(0);
  } finally {
    for (const key of ["OMNIRUSH_TOKEN", "OMNIRUSH_HOST_TOKEN", "OPENCODE_SERVER_PASSWORD", "GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  const names = readFileSync(join(root, ".git", "hook-env-names"), "utf8").split("\n").filter(Boolean);
  expect(names).toContain("PATH");
  expect(names.filter((name) => /^OMNIRUSH_|^OPENCODE_SERVER|TOKEN|PASSWORD|SECRET/.test(name))).toEqual([]);
});
