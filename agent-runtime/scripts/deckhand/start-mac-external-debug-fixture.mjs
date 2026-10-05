import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";

if (NodeOS.type() !== "Darwin") throw new Error("The native WebKit fixture requires a Mac.");
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
NodeFS.mkdirSync(NodePath.join(root, ".deckhand"), { recursive: true });
const state = NodeFS.mkdtempSync(NodePath.join(root, ".deckhand/mac-external-test-"));
const bundle = NodePath.join(state, "MacWebKitFixture.app");
const executable = NodePath.join(bundle, "Contents/MacOS/MacWebKitFixture");
const receipt = NodePath.join(state, "receipt.json");
NodeFS.mkdirSync(NodePath.dirname(executable), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(bundle, "Contents/Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>MacWebKitFixture</string><key>CFBundleIdentifier</key><string>com.cardinlabs.deckhand.mac-debug-fixture</string><key>CFBundleName</key><string>Mac WebKit Test Host</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
);
NodeChildProcess.execFileSync(
  "/usr/bin/xcrun",
  [
    "swiftc",
    "-swift-version",
    "5",
    NodePath.join(root, "native/mac-external-debug/TestHost.swift"),
    "-o",
    executable,
  ],
  { stdio: "inherit" },
);
NodeChildProcess.execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", bundle], {
  stdio: "inherit",
});
const child = NodeChildProcess.spawn(executable, [receipt], { stdio: "inherit" });
console.log(
  `Fixture receipt: ${receipt}\nUndock this fixture's Inspector if needed. Then run:\nnode apps/server/src/deckhand/nativeExternalDebug.smoke.ts ${JSON.stringify(receipt)}\nOffice APIs are simulated. Ctrl-C stops only this fixture.`,
);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
child.once("exit", (code) => {
  process.exitCode = code ?? 0;
});
