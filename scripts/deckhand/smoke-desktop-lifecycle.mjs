import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repo = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const sandbox = await NodeFSP.realpath(NodePath.join(repo, ".deckhand"));
const requested = process.argv[2];
const port = Number(process.argv[3]);
if (
  !requested ||
  !NodePath.isAbsolute(requested) ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error(
    "Usage: node scripts/deckhand/smoke-desktop-lifecycle.mjs /absolute/.deckhand/new-test-root port",
  );
const inside = (path) => path.startsWith(`${sandbox}${NodePath.sep}`);
const root = NodePath.resolve(requested);
if (!inside(root))
  throw new Error("The test root must be inside this checkout's .deckhand directory.");
// A new root makes every run independently reproducible and refuses symlink reuse.
await NodeFSP.mkdir(root);
if (!inside(await NodeFSP.realpath(root))) throw new Error("The test root escaped its sandbox.");
const listening = () =>
  new Promise((resolve) => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
if (await listening()) throw new Error("The selected test port already has a listener.");
const bounded = async (promise, message) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 20000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const child = NodeChildProcess.spawn(
  process.execPath,
  ["apps/desktop/scripts/start-electron.mjs"],
  {
    cwd: repo,
    env: {
      ...process.env,
      DECKHAND_HOME: NodePath.join(root, "server"),
      DECKHAND_PROFILE_ROOT: NodePath.join(root, "profile"),
      DECKHAND_PORT: String(port),
      DECKHAND_DISABLE_AUTO_UPDATE: "true",
      T3CODE_HOME: NodePath.join(root, "forbidden-upstream"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const exit = new Promise((resolve, reject) => {
  child.once("exit", (code, signal) => resolve({ code, signal }));
  child.once("error", reject);
});
let logs = "";
const ready = new Promise((resolve, reject) => {
  const onData = (chunk) => {
    logs = (logs + chunk.toString()).slice(-1048576);
    if (logs.includes("main window created")) resolve();
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.once("error", reject);
  child.once("exit", () => reject(new Error("The desktop exited before its window opened.")));
});
try {
  await bounded(ready, "Desktop startup timed out.");
  child.kill("SIGINT");
  const result = await bounded(exit, "The desktop launcher did not finish shutdown.");
  const backendStillListening = await listening();
  const evidence = {
    capturedLauncherPid: child.pid,
    signal: "SIGINT",
    result,
    backendStillListening,
    port,
  };
  await NodeFSP.writeFile(
    NodePath.join(root, "lifecycle.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence));
  if (backendStillListening || result.code !== 0)
    throw new Error("The desktop did not shut down cleanly.");
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await bounded(exit, "The tracked test launcher still needs cleanup.");
  }
  await NodeFSP.writeFile(NodePath.join(root, "desktop.log"), logs);
}
