// @effect-diagnostics nodeBuiltinImport:off -- The native owner exchanges bounded messages over inherited pipes.
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { NativeHostRoute, NativeToolRequest } from "@t3tools/contracts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";

export const NATIVE_HOST_ROUTE_CHANNEL = "cinderdeck:native-host-route";
export const NATIVE_HOST_READY_CHANNEL = "cinderdeck:native-host-ready";
export const NATIVE_TOOL_CHANNEL = "cinderdeck:native-tool";
export const NATIVE_HOST_INFO_CHANNEL = "cinderdeck:native-host-info";
const MAX_LINE_BYTES = 16 * 1024;
const surfaces = new Set([
  "workspace",
  "lane-map",
  "workspace-setup",
  "workspace-editor",
  "workspace-terminal",
  "execution-map",
  "agent-access",
  "history",
  "preferences",
  "capture",
  "recording",
  "annotate",
  "updates",
]);
let parentRequestedQuit = false;

export function delegateQuitToNative(event: Electron.Event): boolean {
  if (process.env.CINDERDECK_NATIVE_HOST !== "1" || parentRequestedQuit) return false;
  event.preventDefault();
  process.stdout.write("CINDERDECK_AGENT_SHELL_QUIT_REQUEST\n");
  return true;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 160 &&
    !/[\x00-\x1f]/.test(value)
  );
}
function toolRequest(value: unknown): value is NativeToolRequest {
  return (
    record(value) &&
    typeof value.surface === "string" &&
    surfaces.has(value.surface) &&
    Object.keys(value).every((key) => ["surface", "mode", "workspaceID"].includes(key)) &&
    (value.surface !== "workspace-terminal" ||
      (value.workspaceID !== undefined && value.mode === undefined)) &&
    (value.surface !== "agent-access" ||
      (value.mode === undefined && value.workspaceID === undefined)) &&
    (value.workspaceID === undefined || identifier(value.workspaceID)) &&
    (value.mode === undefined || identifier(value.mode))
  );
}

// Pipes belong to the captured native parent. Browser previews never receive
// this bridge, and only the exact top-level application renderer can ask for tools.
export const install = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const info = (event: Electron.IpcMainEvent) => {
    event.returnValue = environment.nativeHost;
  };
  Electron.ipcMain.on(NATIVE_HOST_INFO_CHANNEL, info);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => Electron.ipcMain.removeListener(NATIVE_HOST_INFO_CHANNEL, info)),
  );
  if (!environment.nativeHost) return;
  const windows = yield* ElectronWindow.ElectronWindow;
  const desktop = yield* DesktopWindow.DesktopWindow;
  const context = yield* Effect.context<
    ElectronWindow.ElectronWindow | DesktopWindow.DesktopWindow
  >();
  const run = Effect.runPromiseWith(context);
  let ready = false;
  let latestRoute: NativeHostRoute | null = {};
  let input = "";
  let pendingQuit = false;
  const main = async () => Option.getOrNull(await run(windows.main));
  const trusted = async (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
    const window = await main();
    return Boolean(
      window &&
      !window.isDestroyed() &&
      window.webContents === event.sender &&
      event.senderFrame === event.sender.mainFrame,
    );
  };
  const sendRoute = async () => {
    const window = await main();
    if (ready && latestRoute && window && !window.isDestroyed()) {
      const route = latestRoute;
      latestRoute = null;
      window.webContents.send(NATIVE_HOST_ROUTE_CHANNEL, route);
    }
  };
  const readyListener = (event: Electron.IpcMainEvent) => {
    void trusted(event).then((ok) => {
      if (!ok) return;
      ready = true;
      process.stdout.write("CINDERDECK_AGENT_SHELL_READY\n");
      void sendRoute();
    });
  };
  const quit = () => {
    if (pendingQuit) return;
    pendingQuit = true;
    parentRequestedQuit = true;
    Electron.app.quit();
  };
  const onInput = (chunk: string) => {
    input += chunk;
    if (Buffer.byteLength(input) > MAX_LINE_BYTES && !input.includes("\n")) {
      quit();
      return;
    }
    let end: number;
    while ((end = input.indexOf("\n")) >= 0) {
      const line = input.slice(0, end);
      input = input.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record(value)) continue;
      if (value.type === "quit" && Object.keys(value).length === 1) {
        quit();
        continue;
      }
      if (value.type === "activate" && Object.keys(value).length === 1) {
        void run(desktop.ensureMain).catch(() => undefined);
        continue;
      }
      if (
        value.type !== "route" ||
        !Object.keys(value).every((key) => ["type", "workspaceID", "section"].includes(key)) ||
        (value.workspaceID !== undefined && !identifier(value.workspaceID)) ||
        (value.section !== undefined && !identifier(value.section))
      )
        continue;
      latestRoute = {
        ...(value.workspaceID === undefined ? {} : { workspaceID: value.workspaceID as string }),
        ...(value.section === undefined ? {} : { section: value.section as string }),
      };
      void sendRoute();
    }
    if (Buffer.byteLength(input) > MAX_LINE_BYTES) quit();
  };
  Electron.ipcMain.on(NATIVE_HOST_READY_CHANNEL, readyListener);
  Electron.ipcMain.handle(NATIVE_TOOL_CHANNEL, async (event, value: unknown) => {
    if (!(await trusted(event)) || !toolRequest(value)) return false;
    process.stdout.write("CINDERDECK_AGENT_SHELL_UI_REQUEST " + JSON.stringify(value) + "\n");
    return true;
  });

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onInput);
  process.stdin.on("end", quit);
  process.stdin.resume();
  Electron.app.dock?.hide();
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      Electron.ipcMain.removeListener(NATIVE_HOST_READY_CHANNEL, readyListener);

      Electron.ipcMain.removeHandler(NATIVE_TOOL_CHANNEL);
      process.stdin.removeListener("data", onInput);
      process.stdin.removeListener("end", quit);
      process.stdin.pause();
    }),
  );
});
