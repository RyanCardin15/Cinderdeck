import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
const manifest = JSON.parse(
  NodeFS.readFileSync(
    new URL("../../docs/deckhand/upstream-patches.json", import.meta.url),
    "utf8",
  ),
);
if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(manifest.upstreamRevision))
  throw new Error("Invalid patch manifest");
const changed = new Set(
  [
    ...NodeChildProcess.execFileSync("git", ["diff", "--name-only", manifest.upstreamRevision], {
      encoding: "utf8",
    })
      .trim()
      .split("\n"),
    ...NodeChildProcess.execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n"),
  ].filter(Boolean),
);
const denied = [...changed].filter(
  (path) =>
    !Object.hasOwn(manifest.upstreamEdits, path) &&
    !manifest.ownedPrefixes.some((prefix) => path.startsWith(prefix)),
);
if (denied.length) {
  process.stderr.write(
    `Upstream edits need an explicit integration reason:\n${denied.join("\n")}\n`,
  );
  process.exitCode = 1;
} else
  process.stdout.write(
    `Patch boundary verified: ${changed.size} files; upstream ${manifest.upstreamRevision}.\n`,
  );
