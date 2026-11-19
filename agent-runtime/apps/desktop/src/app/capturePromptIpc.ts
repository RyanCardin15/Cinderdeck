import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { cinderdeckHost } from "./CinderdeckHost.ts";
import { isCapturePromptSettingsUpdate } from "./capturePromptSettings.ts";

const supportedChannel = "cinderdeck:capture-prompt-supported";
const takeChannel = "cinderdeck:capture-prompt-take";
const settingsChannel = "cinderdeck:capture-prompt-settings";

export const installCapturePromptIpc = Effect.gen(function* () {
  const host = cinderdeckHost;
  const supported = (event: Electron.IpcMainEvent) => {
    event.returnValue = host !== null;
  };
  Electron.ipcMain.on(supportedChannel, supported);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => Electron.ipcMain.removeListener(supportedChannel, supported)),
  );
  if (!host) return;

  const { main } = yield* ElectronWindow.ElectronWindow;
  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  const trusted = async (event: Electron.IpcMainInvokeEvent) => {
    const window = Option.getOrNull(await run(main));
    return (
      window !== null &&
      !window.isDestroyed() &&
      window.webContents === event.sender &&
      event.senderFrame === event.sender.mainFrame
    );
  };
  Electron.ipcMain.handle(takeChannel, async (event) => {
    if (!(await trusted(event)))
      throw new Error("Capture prompts are available in the main window.");
    return host.takeCapture();
  });
  Electron.ipcMain.handle(settingsChannel, async (event, update: unknown) => {
    if (!(await trusted(event)) || (update !== undefined && !isCapturePromptSettingsUpdate(update)))
      throw new Error("Invalid capture settings request.");
    return host.captureSettings(update);
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      Electron.ipcMain.removeHandler(takeChannel);
      Electron.ipcMain.removeHandler(settingsChannel);
    }),
  );
});
