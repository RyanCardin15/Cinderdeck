import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const output = NodePath.resolve(
  process.argv[2] ?? NodePath.resolve(root, ".deckhand/native/deckhand-mac-external-debug"),
);
if (NodeOS.type() !== "Darwin") throw new Error("Build the macOS helper on a Mac.");
NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
const source = NodePath.resolve(root, "native/mac-external-debug/main.swift");
const paths = [];
try {
  for (const arch of ["arm64", "x86_64"]) {
    const path = `${output}.${arch}`;
    paths.push(path);
    NodeChildProcess.execFileSync(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-parse-as-library",
        "-swift-version",
        "5",
        "-O",
        "-target",
        `${arch}-apple-macos14.0`,
        source,
        "-o",
        path,
      ],
      { stdio: "inherit" },
    );
  }
  NodeChildProcess.execFileSync("/usr/bin/lipo", ["-create", ...paths, "-output", output], {
    stdio: "inherit",
  });
  NodeChildProcess.execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", output], {
    stdio: "inherit",
  });
  console.log(`Built ${output}`);
} finally {
  for (const path of paths) NodeFS.rmSync(path, { force: true });
}
