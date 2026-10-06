import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Launches only its own synthetic AppKit fixture; no third-party apps or live data.
if (process.platform !== "darwin") throw new Error("Run this fixture on macOS 14 or newer.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sources = join(root, "native/mac-computer-use");
const args = process.argv.slice(2);
const external = args.includes("--external");
const helperFlag = args.indexOf("--helper");
const helper =
  helperFlag >= 0 ? args[helperFlag + 1] : join(root, ".deckhand/native/deckhand-mac-computer-use");
if (external && !helper) throw new Error("Pass an absolute helper path after --helper.");
const temporary = mkdtempSync(join(tmpdir(), "computer-use-fixture-"));
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit", timeout: 60_000 });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.signal ?? result.status}).`);
};
try {
  const executable = join(temporary, "fixture");
  run("/usr/bin/xcrun", [
    "swiftc",
    "-parse-as-library",
    "-swift-version",
    "5",
    "-O",
    "-D",
    "COMPUTER_USE_TESTS",
    "-module-cache-path",
    join(temporary, "modules"),
    ...readdirSync(sources)
      .filter((name) => name.endsWith(".swift"))
      .sort()
      .map((name) => join(sources, name)),
    join(sources, "tests/Fixture.swift"),
    "-o",
    executable,
  ]);
  for (let i = 0; i < 3; i++) run(executable, []);
  if (external)
    run("/usr/bin/python3", [
      join(sources, "tests/external.py"),
      executable,
      resolve(helper),
      temporary,
    ]);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
