import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { engineToolsRoot, helperPath, installShell, setToolsRoot } from "./box.js";

const dirs: string[] = [];
afterEach(() => {
  setToolsRoot(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An app's sidecars folder with only the 2.x engine and the box helpers of each OS (the 3.7.6 layout). */
function sidecars(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "box-sidecars-"));
  dirs.push(dir);
  writeFileSync(path.join(dir, "opencode2-x86_64-unknown-linux-gnu"), "");
  for (const [osArch, name] of [["linux-amd64", "boxsh"], ["darwin-arm64", "boxsh"], ["windows-amd64", "boxsh.exe"]]) {
    mkdirSync(path.join(dir, "box", osArch!), { recursive: true });
    writeFileSync(path.join(dir, "box", osArch!, name!), "");
  }
  return dir;
}

test("an app without the 1.x engine finds the box helpers beside the 2.x engine", () => {
  const dir = sidecars();
  const env = { OMNIRUSH_OPENCODE2_BIN: path.join(dir, "opencode2-x86_64-unknown-linux-gnu") };
  expect(engineToolsRoot(undefined, env)).toBe(dir);
  setToolsRoot(engineToolsRoot(undefined, env));
  expect(helperPath("boxsh", { goos: "linux", goarch: "amd64", env: {} })).toBe(path.join(dir, "box", "linux-amd64", "boxsh"));
  // The same folder on macOS and Windows (the desktop sets OMNIRUSH_OPENCODE2_BIN to sidecars/opencode2-<triple> on every OS).
  expect(helperPath("boxsh", { goos: "darwin", goarch: "arm64", env: {} })).toBe(path.join(dir, "box", "darwin-arm64", "boxsh"));
  expect(helperPath("boxsh", { goos: "windows", goarch: "amd64", env: {} })).toBe(path.join(dir, "box", "windows-amd64", "boxsh.exe"));
  const home = mkdtempSync(path.join(tmpdir(), "box-home-"));
  dirs.push(home);
  const shell = installShell(home, { platform: "linux", arch: "x64", env: {} });
  expect(readlinkSync(shell)).toBe(path.join(dir, "box", "linux-amd64", "boxsh"));
});

test("the 1.x engine's folder still wins when it ships, and nothing is guessed without an engine", () => {
  expect(engineToolsRoot("/app/sidecars/opencode", { OMNIRUSH_OPENCODE2_BIN: "/other/opencode2" })).toBe("/app/sidecars");
  expect(engineToolsRoot(null, { OMNIRUSH_OPENCODE_BIN: " /a/opencode ", OMNIRUSH_OPENCODE2_BIN: "/b/opencode2" })).toBe("/a");
  expect(engineToolsRoot(null, {})).toBeNull();
});
