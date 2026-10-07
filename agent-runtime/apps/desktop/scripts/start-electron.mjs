import * as NodeChildProcess from "node:child_process";

import { desktopDir, resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const electronCommand = resolveElectronLaunchCommand(["dist-electron/main.cjs"]);
const child = NodeChildProcess.spawn(electronCommand.electronPath, electronCommand.args, {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
});

// Keep the launcher alive until Electron's lifecycle has drained its backend pool.
const interrupt = () => child.kill("SIGTERM");
const terminate = () => child.kill("SIGTERM");
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);

child.on("exit", (code, signal) => {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
