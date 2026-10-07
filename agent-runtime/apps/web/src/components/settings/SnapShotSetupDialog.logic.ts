import type { DesktopSnapShotState } from "@cinderdeck/contracts";

export type CaptureSetupStep = "access" | "shortcut";

export function captureSetupAccessReady(state: DesktopSnapShotState): boolean {
  return state.mode !== "unavailable" && !state.message;
}

export function captureSetupMacPermissionsReady(
  state: DesktopSnapShotState,
  includeAccessibility: boolean,
): boolean {
  const permissions = state.macPermissions;
  if (!permissions) return true;
  return permissions.screenRecording && (!includeAccessibility || permissions.accessibility);
}

export function captureSetupShortcutReady(state: DesktopSnapShotState, unsaved: boolean): boolean {
  return !unsaved && captureSetupAccessReady(state) && state.shortcutRegistered;
}

export function captureSetupInitialStep(
  state: DesktopSnapShotState,
  requested: CaptureSetupStep | "resume" = "resume",
): CaptureSetupStep {
  if (!captureSetupAccessReady(state)) return "access";
  if (requested === "resume") {
    // A disabled native backend hasn't checked system permissions yet, so it is
    // not proof of active-window access.
    if (state.mode === "direct" && !state.shortcutRegistered) return "access";
    return "shortcut";
  }
  return requested;
}

export function captureSetupShouldDisableOnClose(wasEnabled: boolean, completed: boolean): boolean {
  return !wasEnabled && !completed;
}
