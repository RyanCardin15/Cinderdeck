import { DEFAULT_CLIENT_SETTINGS, type DesktopSnapShotState } from "@cinderdeck/contracts";
import { expect, it } from "vite-plus/test";
import {
  captureSetupAccessReady,
  captureSetupInitialStep,
  captureSetupMacPermissionsReady,
  captureSetupShortcutReady,
  captureSetupShouldDisableOnClose,
} from "./SnapShotSetupDialog.logic";

const mac: DesktopSnapShotState = {
  mode: "direct",
  shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
  shortcutRegistered: true,
  shortcutMessage: null,
  shortcutVerified: false,
  message: null,
  macPermissions: { screenRecording: true, accessibility: true },
};

it("declares access ready only for supported capture without an outstanding message", () => {
  expect(captureSetupAccessReady(mac)).toBe(true);
  expect(captureSetupAccessReady({ ...mac, message: "Check access" })).toBe(false);
  expect(captureSetupAccessReady({ ...mac, mode: "unavailable" })).toBe(false);
});

it("finishes setup with a saved shortcut without requiring a separate delivery test", () => {
  expect(captureSetupInitialStep(mac)).toBe("shortcut");
  expect(captureSetupShortcutReady(mac, false)).toBe(true);
});

it("still allows revisiting capture access and editing a saved shortcut", () => {
  expect(captureSetupInitialStep(mac, "access")).toBe("access");
  expect(captureSetupInitialStep(mac, "shortcut")).toBe("shortcut");
});

it("does not skip native permission setup when capture has not been enabled", () => {
  expect(captureSetupInitialStep({ ...mac, shortcutRegistered: false })).toBe("access");
  expect(captureSetupInitialStep({ ...mac, shortcutRegistered: false }, "shortcut")).toBe(
    "shortcut",
  );
});

it("keeps setup on the access step while capture needs attention", () => {
  const state = { ...mac, message: "Allow Screen Recording in System Settings." };
  expect(captureSetupInitialStep(state)).toBe("access");
  expect(captureSetupInitialStep(state, "shortcut")).toBe("access");
});

it("requires saving a changed chord before finishing setup", () => {
  expect(captureSetupShortcutReady(mac, true)).toBe(false);
  expect(captureSetupShortcutReady(mac, false)).toBe(true);
  expect(captureSetupShortcutReady({ ...mac, shortcutRegistered: false }, false)).toBe(false);
});

it.each([false, true])(
  "does not require a previously observed shortcut activation (%s)",
  (shortcutVerified) => {
    const state = { ...mac, shortcutVerified };
    expect(captureSetupShortcutReady(state, false)).toBe(true);
    expect(captureSetupInitialStep(state)).toBe("shortcut");
  },
);

it("blocks finishing if desktop access is lost during the wizard", () => {
  expect(
    captureSetupShortcutReady(
      {
        ...mac,
        shortcutVerified: true,
        message: "Desktop disconnected",
      },
      false,
    ),
  ).toBe(false);
  expect(captureSetupAccessReady({ ...mac, mode: "unavailable" })).toBe(false);
});

it.each([
  [false, false, true],
  [false, true, false],
  [true, false, false],
  [true, true, false],
] as const)(
  "closing setup (previously enabled=%s, completed=%s) disables only an unfinished first opt-in",
  (wasEnabled, completed, disable) => {
    expect(captureSetupShouldDisableOnClose(wasEnabled, completed)).toBe(disable);
  },
);

it("gates Continue on macOS permissions, requiring accessibility only when app text is on", () => {
  const state: DesktopSnapShotState = {
    ...mac,
    macPermissions: { screenRecording: true, accessibility: false },
  };
  expect(captureSetupMacPermissionsReady(state, true)).toBe(false);
  expect(captureSetupMacPermissionsReady(state, false)).toBe(true);
  expect(
    captureSetupMacPermissionsReady(
      { ...state, macPermissions: { screenRecording: false, accessibility: true } },
      false,
    ),
  ).toBe(false);
  expect(captureSetupMacPermissionsReady({ ...state, macPermissions: undefined }, true)).toBe(true);
});
