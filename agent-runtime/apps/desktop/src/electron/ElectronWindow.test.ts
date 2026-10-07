import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@cinderdeck/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Electron from "electron";
import { beforeEach, vi } from "vite-plus/test";

const { appFocusMock, browserWindowMock, getAllWindowsMock, getFocusedWindowMock } = vi.hoisted(
  () => ({
    appFocusMock: vi.fn(),
    browserWindowMock: vi.fn(function BrowserWindowMock() {}),
    getAllWindowsMock: vi.fn(),
    getFocusedWindowMock: vi.fn(),
  }),
);

vi.mock("electron", () => ({
  app: {
    focus: appFocusMock,
  },
  BrowserWindow: Object.assign(browserWindowMock, {
    getAllWindows: getAllWindowsMock,
    getFocusedWindow: getFocusedWindowMock,
  }),
}));

import * as ElectronWindow from "./ElectronWindow.ts";

const testLayer = (platform: NodeJS.Platform) =>
  ElectronWindow.layer.pipe(Layer.provide(Layer.succeed(HostProcessPlatform, platform)));

const TestLayer = testLayer("darwin");

function makeBrowserWindow(input: { readonly id: number; readonly destroyed: boolean }) {
  return {
    id: input.id,
    isDestroyed: vi.fn(() => input.destroyed),
  } as unknown as Electron.BrowserWindow;
}

function makeRevealWindow(input: { readonly visible: boolean }) {
  return {
    id: 41,
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    isVisible: vi.fn(() => input.visible),
    show: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
  };
}

describe("ElectronWindow", () => {
  beforeEach(() => {
    appFocusMock.mockReset();
    browserWindowMock.mockReset();
    getAllWindowsMock.mockReset();
    getFocusedWindowMock.mockReset();
  });

  it.effect("preserves schema-safe creation context and the Electron cause", () =>
    Effect.gen(function* () {
      const cause = new Error("native BrowserWindow construction failed");
      browserWindowMock.mockImplementationOnce(function BrowserWindowFailure() {
        throw cause;
      });
      const options = {
        title: "Cinderdeck",
        width: 1100,
        height: 780,
        minWidth: 840,
        minHeight: 620,
        show: false,
        modal: false,
        frame: true,
        transparent: false,
        backgroundColor: "#101010",
        icon: {} as Electron.NativeImage,
        webPreferences: {
          preload: "/tmp/preload.js",
          partition: "persist:t3code-preview-test",
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: true,
          spellcheck: true,
        },
      } satisfies Electron.BrowserWindowConstructorOptions;
      const electronWindow = yield* ElectronWindow.ElectronWindow;

      const error = yield* electronWindow.create(options).pipe(Effect.flip);

      assert.instanceOf(error, ElectronWindow.ElectronWindowCreateError);
      assert.deepEqual(error.options, {
        title: "Cinderdeck",
        width: 1100,
        height: 780,
        minWidth: 840,
        minHeight: 620,
        show: false,
        modal: false,
        frame: true,
        transparent: false,
        backgroundColor: "#101010",
        webPreferences: {
          preload: "/tmp/preload.js",
          partition: "persist:t3code-preview-test",
          backgroundThrottling: null,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webviewTag: true,
        },
      });
      assert.isFalse("icon" in error.options);
      assert.isFalse("spellcheck" in error.options.webPreferences);
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, 'Failed to create Electron BrowserWindow "Cinderdeck" (1100x780).');
      assert.notInclude(error.message, cause.message);
      assert.deepEqual(browserWindowMock.mock.calls, [[options]]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("skips windows destroyed before appearance sync runs", () =>
    Effect.gen(function* () {
      const liveWindow = makeBrowserWindow({ id: 1, destroyed: false });
      const destroyedWindow = makeBrowserWindow({ id: 2, destroyed: true });
      getAllWindowsMock.mockReturnValue([destroyedWindow, liveWindow]);

      const syncedWindows: Electron.BrowserWindow[] = [];
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      yield* electronWindow.syncAllAppearance((window) =>
        Effect.sync(() => {
          syncedWindows.push(window);
        }),
      );

      assert.deepEqual(syncedWindows, [liveWindow]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves window enumeration failures as structured defects", () =>
    Effect.gen(function* () {
      const cause = new Error("window enumeration failed");
      getAllWindowsMock.mockImplementationOnce(() => {
        throw cause;
      });

      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const exit = yield* Effect.exit(electronWindow.currentMainOrFirst);

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronWindow.ElectronWindowOperationError);
        assert.equal(error.operation, "list-windows");
        assert.equal(error.platform, "darwin");
        assert.isNull(error.windowId);
        assert.isNull(error.channel);
        assert.strictEqual(error.cause, cause);
        assert.notInclude(error.message, cause.message);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves reveal failures with the target window", () =>
    Effect.gen(function* () {
      const cause = new Error("window restore failed");
      const window = {
        id: 41,
        isDestroyed: vi.fn(() => false),
        isMinimized: vi.fn(() => true),
        restore: vi.fn(() => {
          throw cause;
        }),
      } as unknown as Electron.BrowserWindow;

      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const exit = yield* Effect.exit(electronWindow.reveal(window));

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronWindow.ElectronWindowOperationError);
        assert.equal(error.operation, "reveal-window");
        assert.equal(error.windowId, 41);
        assert.isNull(error.channel);
        assert.strictEqual(error.cause, cause);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves message delivery failures with window and channel context", () =>
    Effect.gen(function* () {
      const cause = new Error("renderer send failed");
      const window = {
        id: 42,
        isDestroyed: vi.fn(() => false),
        webContents: {
          send: vi.fn(() => {
            throw cause;
          }),
        },
      } as unknown as Electron.BrowserWindow;
      getAllWindowsMock.mockReturnValueOnce([window]);

      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const exit = yield* Effect.exit(electronWindow.sendAll("desktop:update", { ready: true }));

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronWindow.ElectronWindowOperationError);
        assert.equal(error.operation, "send-window-message");
        assert.equal(error.windowId, 42);
        assert.equal(error.channel, "desktop:update");
        assert.strictEqual(error.cause, cause);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("preserves destroy failures and continues with later windows", () =>
    Effect.gen(function* () {
      const cause = new Error("window destroy failed");
      const window = {
        id: 43,
        destroy: vi.fn(() => {
          throw cause;
        }),
      } as unknown as Electron.BrowserWindow;
      const laterWindow = {
        id: 44,
        destroy: vi.fn(),
      } as unknown as Electron.BrowserWindow;
      getAllWindowsMock.mockReturnValueOnce([window, laterWindow]);

      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const exit = yield* Effect.exit(electronWindow.destroyAll);

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronWindow.ElectronWindowOperationError);
        assert.equal(error.operation, "destroy-window");
        assert.equal(error.windowId, 43);
        assert.isNull(error.channel);
        assert.strictEqual(error.cause, cause);
      }
      assert.equal(vi.mocked(laterWindow.destroy).mock.calls.length, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("shows a hidden window and steals focus for it", () =>
    Effect.gen(function* () {
      const window = makeRevealWindow({ visible: false });
      const electronWindow = yield* ElectronWindow.ElectronWindow;

      assert.isFalse(
        yield* electronWindow.prepareReveal(window as unknown as Electron.BrowserWindow),
      );
      yield* electronWindow.reveal(window as unknown as Electron.BrowserWindow);

      assert.lengthOf(window.show.mock.calls, 1);
      assert.deepEqual(appFocusMock.mock.calls, [[{ steal: true }]]);
      assert.lengthOf(window.focus.mock.calls, 1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("does not re-show a visible window", () =>
    Effect.gen(function* () {
      const window = makeRevealWindow({ visible: true });
      const electronWindow = yield* ElectronWindow.ElectronWindow;

      yield* electronWindow.reveal(window as unknown as Electron.BrowserWindow);

      assert.lengthOf(window.show.mock.calls, 0);
      assert.lengthOf(window.focus.mock.calls, 1);
    }).pipe(Effect.provide(TestLayer)),
  );
});
