import * as NodeEvents from "node:events";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, expect, vi } from "vite-plus/test";

vi.mock("electron", () => ({
  ipcMain: {
    on: vi.fn(),
    removeListener: vi.fn(),
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  app: { dock: { hide: vi.fn() }, quit: vi.fn(), hide: vi.fn() },
}));

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { hideOwnedApplication, hideOtherApplications, install } from "./NativeHostBridge.ts";
import * as Electron from "electron";

afterEach(() => vi.restoreAllMocks());

function makeBridge() {
  const input = Object.assign(new NodeEvents.EventEmitter(), {
    setEncoding: vi.fn(),
    resume: vi.fn(),
    pause: vi.fn(),
  });
  vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
  const activate = vi.fn();
  const ensureMain = vi.fn();
  const sendRoute = vi.fn();
  const window = { isDestroyed: () => false, webContents: { send: sendRoute } };
  const layer = Layer.mergeAll(
    DesktopEnvironment.layer({
      dirname: "/repo/apps/desktop/dist-electron",
      homeDirectory: "/Users/test",
      platform: "darwin",
      processArch: "arm64",
      appVersion: "1.0.0",
      appPath: "/repo",
      isPackaged: true,
      resourcesPath: "/repo/resources",
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          DesktopConfig.layerTest({ CINDERDECK_NATIVE_HOST: "1" }),
        ),
      ),
    ),
    Layer.mock(ElectronWindow.ElectronWindow)({
      main: Effect.succeedSome(window as unknown as import("electron").BrowserWindow),
    }),
    Layer.mock(DesktopWindow.DesktopWindow)({
      activate: Effect.sync(activate),
      ensureMain: Effect.sync(ensureMain),
    }),
  );
  return { input, activate, ensureMain, sendRoute, layer };
}

it.effect(
  "activates the main window for every native Dock request without changing its route",
  () =>
    Effect.gen(function* () {
      const bridge = makeBridge();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* install;
          yield* Effect.promise(async () => {
            // Pipe reads can split a request or contain several requests.
            bridge.input.emit("data", '{"type":"acti');
            bridge.input.emit("data", 'vate"}\n{"type":"activate"}\n');
            await expect.poll(() => bridge.activate.mock.calls.length).toBe(2);
            expect(bridge.ensureMain).not.toHaveBeenCalled();
            expect(bridge.sendRoute).not.toHaveBeenCalled();
          });
        }),
      ).pipe(Effect.provide(bridge.layer));
      expect(bridge.input.listenerCount("data")).toBe(0);
    }),
);

it.effect("refuses native activation requests with extra fields", () =>
  Effect.gen(function* () {
    const bridge = makeBridge();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* install;
        yield* Effect.promise(async () => {
          bridge.input.emit("data", '{"type":"activate","section":"settings"}\n');
          bridge.input.emit("data", '{"type":"activate"}\n');
          await expect.poll(() => bridge.activate.mock.calls.length).toBe(1);
          expect(bridge.sendRoute).not.toHaveBeenCalled();
        });
      }),
    ).pipe(Effect.provide(bridge.layer));
  }),
);

it.effect("coordinates native and runtime hiding without treating it as activation", () =>
  Effect.gen(function* () {
    const bridge = makeBridge();
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.mocked(Electron.app.hide).mockClear();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* install;
        bridge.input.emit("data", '{"type":"hide"}\n{"type":"hide","section":"settings"}\n');
        expect(Electron.app.hide).toHaveBeenCalledTimes(1);
        expect(bridge.activate).not.toHaveBeenCalled();
        hideOwnedApplication();
        expect(Electron.app.hide).toHaveBeenCalledTimes(2);
        hideOtherApplications();
        expect(output).toHaveBeenCalledWith("CINDERDECK_RUNTIME_HIDE_OTHERS\n");
        expect(output).toHaveBeenCalledWith("CINDERDECK_RUNTIME_HIDE\n");
      }),
    ).pipe(Effect.provide(bridge.layer));
  }),
);
