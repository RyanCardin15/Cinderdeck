import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";

// Builds the universal background computer-use helper next to the external-debug helper.
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const output = NodePath.resolve(
  process.argv[2] ?? NodePath.resolve(root, ".deckhand/native/deckhand-mac-computer-use"),
);
if (NodeOS.type() !== "Darwin") throw new Error("Build the macOS helper on a Mac.");
NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
const sourceDir = NodePath.resolve(root, "native/mac-computer-use");
const sources = NodeFS.readdirSync(sourceDir)
  .filter((name) => name.endsWith(".swift"))
  .sort()
  .map((name) => NodePath.join(sourceDir, name));
const paths = ["arm64", "x86_64"].map((arch) => `${output}.${arch}`);
const compile = (arch, path) =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      "/usr/bin/xcrun",
      [
        "swiftc",
        "-parse-as-library",
        "-swift-version",
        "5",
        "-O",
        "-target",
        `${arch}-apple-macos14.0`,
        ...sources,
        "-o",
        path,
      ],
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`swiftc ${arch} failed (${signal ?? code}).`)),
    );
  });
try {
  const results = await Promise.allSettled(
    ["arm64", "x86_64"].map((arch, index) => compile(arch, paths[index])),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
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
