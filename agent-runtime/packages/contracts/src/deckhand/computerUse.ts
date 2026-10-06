import * as Schema from "effect/Schema";

// Background computer use: agents read a Mac app's accessibility tree and act
// on it without moving the user's pointer or activating the app.

const appName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).annotate({
  description:
    "App bundle ID (preferred, e.g. com.microsoft.Excel), display name, or process name from computer_list_apps.",
});
const elementIndex = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 10_000_000 }),
).annotate({
  description: "Element index from the latest computer_get_app_state text.",
});
const coordinate = Schema.Number.check(Schema.isBetween({ minimum: -20_000, maximum: 20_000 }));
const screenshotX = coordinate.annotate({
  description: "X in the latest screenshot's pixels (window-relative).",
});
const screenshotY = coordinate.annotate({
  description: "Y in the latest screenshot's pixels (window-relative).",
});

export const ComputerApp = Schema.Struct({ app: appName });
export type ComputerApp = typeof ComputerApp.Type;

export const ComputerGetAppState = Schema.Struct({
  app: appName,
  disableDiff: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Return the full accessibility tree instead of changes since this conversation's previous read of the app.",
    }),
  ),
  includeScreenshot: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Include a screenshot of the window. Defaults to true.",
    }),
  ),
  window: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 })).annotate({
      description: "Window index from the state's window list. Later actions target this window.",
    }),
  ),
});
export type ComputerGetAppState = typeof ComputerGetAppState.Type;

export const ComputerMouseButton = Schema.Literals(["left", "right", "middle", "l", "r", "m"]);
export const ComputerClick = Schema.Struct({
  app: appName,
  element_index: Schema.optionalKey(elementIndex),
  x: Schema.optionalKey(screenshotX),
  y: Schema.optionalKey(screenshotY),
  mouse_button: Schema.optionalKey(ComputerMouseButton),
  click_count: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
});
export type ComputerClick = typeof ComputerClick.Type;

export const ComputerDrag = Schema.Struct({
  app: appName,
  from_x: screenshotX,
  from_y: screenshotY,
  to_x: screenshotX,
  to_y: screenshotY,
});
export type ComputerDrag = typeof ComputerDrag.Type;

export const ComputerPressKey = Schema.Struct({
  app: appName,
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).annotate({
    description:
      "Key or +-separated chord with X keysym names: a, Return, Tab, space, BackSpace, Escape, Up, Page_Down, F5, KP_0, period, super+s (Command-S), Control_L+Shift_L+period. super/cmd/command = Command, alt/option = Option.",
  }),
});
export type ComputerPressKey = typeof ComputerPressKey.Type;

export const ComputerTypeText = Schema.Struct({
  app: appName,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
  element_index: Schema.optionalKey(
    elementIndex.annotate({
      description: "Focus this editable element first. Defaults to the current focus.",
    }),
  ),
});
export type ComputerTypeText = typeof ComputerTypeText.Type;

export const ComputerScrollDirection = Schema.Literals(["up", "down", "left", "right"]);
export const ComputerScroll = Schema.Struct({
  app: appName,
  direction: ComputerScrollDirection,
  element_index: Schema.optionalKey(elementIndex),
  x: Schema.optionalKey(screenshotX),
  y: Schema.optionalKey(screenshotY),
  pages: Schema.optionalKey(
    Schema.Number.check(Schema.isBetween({ minimum: 0.1, maximum: 20 })).annotate({
      description: "Visible pages to scroll. Defaults to 1.",
    }),
  ),
});
export type ComputerScroll = typeof ComputerScroll.Type;

export const ComputerSetValue = Schema.Struct({
  app: appName,
  element_index: elementIndex,
  value: Schema.String.check(Schema.isMaxLength(100_000)),
});
export type ComputerSetValue = typeof ComputerSetValue.Type;

export const ComputerSelectText = Schema.Struct({
  app: appName,
  element_index: elementIndex,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_000)),
  prefix: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(1000)).annotate({
      description: "Text immediately before the match, to pick one of several occurrences.",
    }),
  ),
  suffix: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1000))),
  selection_type: Schema.optionalKey(Schema.Literals(["text", "cursor_before", "cursor_after"])),
});
export type ComputerSelectText = typeof ComputerSelectText.Type;

export const ComputerSecondaryAction = Schema.Struct({
  app: appName,
  element_index: elementIndex,
  action: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).annotate({
    description: "A Secondary Actions label from the state, such as Show Menu, Raise, Increment.",
  }),
});
export type ComputerSecondaryAction = typeof ComputerSecondaryAction.Type;

export const ComputerPaste = Schema.Struct({
  app: appName,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200_000)),
});
export type ComputerPaste = typeof ComputerPaste.Type;

export const ComputerScript = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
  timeout_ms: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 300_000 })).annotate({
      description: "Deadline for the whole script. Defaults to 60000.",
    }),
  ),
  reset: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Discard globals kept from earlier scripts first." }),
  ),
});
export type ComputerScript = typeof ComputerScript.Type;

export const ComputerPermissions = Schema.Struct({
  accessibility: Schema.Boolean,
  screenRecording: Schema.Boolean,
  postEvents: Schema.Boolean,
  screenLocked: Schema.Boolean,
  backgroundFocus: Schema.Boolean,
});
export type ComputerPermissions = typeof ComputerPermissions.Type;

export const ComputerAppInfo = Schema.Struct({
  id: Schema.String,
  displayName: Schema.optionalKey(Schema.String),
  isRunning: Schema.optionalKey(Schema.Boolean),
  lastUsedDate: Schema.optionalKey(Schema.String),
  useCount: Schema.optionalKey(Schema.Number),
});
export type ComputerAppInfo = typeof ComputerAppInfo.Type;

export const ComputerListAppsResult = Schema.Struct({
  apps: Schema.Array(ComputerAppInfo),
  permissions: ComputerPermissions,
});
export type ComputerListAppsResult = typeof ComputerListAppsResult.Type;

export const ComputerScreenshot = Schema.Struct({
  data: Schema.String,
  mimeType: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
});
export type ComputerScreenshot = typeof ComputerScreenshot.Type;

export const ComputerAppState = Schema.Struct({
  app: Schema.String,
  name: Schema.String,
  text: Schema.String,
  diff: Schema.Boolean,
  screenshot: Schema.NullOr(ComputerScreenshot),
});
export type ComputerAppState = typeof ComputerAppState.Type;

export const ComputerActionResult = Schema.Struct({
  ok: Schema.Boolean,
  app: Schema.String,
  note: Schema.optionalKey(Schema.String),
});
export type ComputerActionResult = typeof ComputerActionResult.Type;

export const ComputerScriptResult = Schema.Struct({
  output: Schema.String,
  ok: Schema.Boolean,
  screenshots: Schema.Array(ComputerScreenshot),
});
export type ComputerScriptResult = typeof ComputerScriptResult.Type;

export class ComputerUseError extends Schema.TaggedError<ComputerUseError>()("ComputerUseError", {
  reason: Schema.Literals([
    "accessibility_permission",
    "screen_permission",
    "post_event_permission",
    "app_missing",
    "app_blocked",
    "app_busy",
    "approval_denied",
    "window_missing",
    "element_stale",
    "element_missing",
    "unsupported_action",
    "invalid_input",
    "screen_locked",
    "not_settable",
    "text_not_found",
    "launch_failed",
    "native_unavailable",
    "timeout",
    "busy",
    "unavailable",
  ]),
  detail: Schema.optionalKey(Schema.String),
}) {
  override get message() {
    const messages: Record<ComputerUseError["reason"], string> = {
      accessibility_permission:
        "Allow Accessibility for Cinderdeck in System Settings → Privacy & Security, then retry.",
      screen_permission:
        "Allow Screen & System Audio Recording for Cinderdeck to include screenshots. The accessibility tree still works without it.",
      post_event_permission:
        "Allow Cinderdeck to control this computer (Accessibility) to send clicks and keys.",
      app_missing: "That app is not installed or running. Check computer_list_apps.",
      app_blocked:
        "Computer use is not available for terminals, Cinderdeck itself, or system security and password prompts. Use a dedicated tool instead.",
      app_busy:
        "Another conversation is using this app right now. Wait for it to finish, or use a different app.",
      approval_denied: "The person at this Mac did not allow this conversation to use the app.",
      window_missing: "The app has no matching open window. Read the app state again.",
      element_stale: "That element no longer exists. Read the app state again for fresh indexes.",
      element_missing:
        "That element index is not in the latest state. Read the app state again for fresh indexes.",
      unsupported_action: "The element does not support that action.",
      invalid_input: "The request is missing or has invalid input.",
      screen_locked: "The Mac is locked. Computer use needs an unlocked session.",
      not_settable: "The element's value cannot be set directly. Click it and type instead.",
      text_not_found: "The requested text was not found in the element.",
      launch_failed: "The app could not be launched.",
      native_unavailable:
        "The computer-use helper is unavailable. Use the Mac desktop build, or build it with node scripts/deckhand/build-mac-computer-use.mjs. Requires macOS 14 or newer.",
      timeout: "The app did not respond in time. It may be busy or showing a modal dialog.",
      busy: "Too many computer-use requests are in flight. Retry shortly.",
      unavailable: "The computer-use request could not be completed.",
    };
    return this.detail ? `${messages[this.reason]} (${this.detail})` : messages[this.reason];
  }
}

/** Never automated: terminals and the system's credential and consent UI. */
export const COMPUTER_USE_BLOCKED_BUNDLE_IDS: ReadonlySet<string> = new Set(
  [
    "com.apple.Terminal",
    "com.googlecode.iterm2",
    "dev.warp.Warp-Stable",
    "dev.warp.Warp",
    "net.kovidgoyal.kitty",
    "org.alacritty",
    "io.alacritty",
    "com.mitchellh.ghostty",
    "com.github.wez.wezterm",
    "co.zeit.hyper",
    "com.apple.SecurityAgent",
    "com.apple.LocalAuthentication.UIAgent",
    "com.apple.loginwindow",
    "com.apple.keychainaccess",
    "com.apple.Passwords",
  ].map((id) => id.toLowerCase()),
);

export const isComputerUseBlocked = (bundleId: string) => {
  const id = bundleId.toLowerCase();
  return COMPUTER_USE_BLOCKED_BUNDLE_IDS.has(id) || id.includes("cinderdeck");
};
