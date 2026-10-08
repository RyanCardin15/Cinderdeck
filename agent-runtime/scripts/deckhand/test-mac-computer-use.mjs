import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Launches only its own synthetic AppKit fixture; no third-party apps or live data.
// oxlint-disable-next-line cinderdeck/no-global-process-runtime -- Standalone synthetic fixture launcher has no injected Effect runtime.
if (NodeOS.platform() !== "darwin") throw new Error("Run this fixture on macOS 14 or newer.");
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const sources = NodePath.join(root, "native/mac-computer-use");
const args = process.argv.slice(2);
const external = args.includes("--external");
const helperFlag = args.indexOf("--helper");
const helper =
  helperFlag >= 0 ? args[helperFlag + 1] : NodePath.join(root, ".deckhand/native/deckhand-mac-computer-use");
if (external && !helper) throw new Error("Pass an absolute helper path after --helper.");
const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "computer-use-fixture-"));
const run = (command, args) => {
  const result = NodeChildProcess.spawnSync(command, args, { stdio: "inherit", timeout: 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.signal ?? result.status}).`);
};
try {
  const executable = NodePath.join(temporary, "fixture");
  run("/usr/bin/xcrun", [
    "swiftc",
    "-parse-as-library",
    "-swift-version",
    "5",
    "-O",
    "-D",
    "COMPUTER_USE_TESTS",
    "-module-cache-path",
    NodePath.join(temporary, "modules"),
    ...readdirSync(sources)
      .filter((name) => name.endsWith(".swift"))
      .sort()
      .map((name) => NodePath.join(sources, name)),
    NodePath.join(sources, "tests/Fixture.swift"),
    "-o",
    executable,
  ]);
  for (let i = 0; i < 3; i++) run(executable, []);
  if (external)
    run("/usr/bin/python3", [
      NodePath.join(sources, "tests/external.py"),
      executable,
      NodePath.resolve(helper),
      temporary,
    ]);
} finally {
  NodeFS.rmSync(temporary, { recursive: true, force: true });
}
