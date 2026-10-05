import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { EnvironmentAuthorizationError } from "../auth.ts";
import { NonNegativeInt, TrimmedNonEmptyString, ThreadId } from "../baseSchemas.ts";

const id = TrimmedNonEmptyString.check(Schema.isMaxLength(240));
const text = Schema.String.check(Schema.isMaxLength(8192));
export const EXTERNAL_DEBUG_METHODS = {
  discover: "deckhand.externalDebug.discover",
  open: "deckhand.externalDebug.open",
  attach: "deckhand.externalDebug.attach",
  sessions: "deckhand.externalDebug.sessions",
  read: "deckhand.externalDebug.read",
  command: "deckhand.externalDebug.command",
  detach: "deckhand.externalDebug.detach",
} as const;
export const DebugEndpoint = Schema.Struct({ endpoint: id });
export type DebugEndpoint = typeof DebugEndpoint.Type;
export const DebugTarget = Schema.Struct({
  id,
  title: text,
  url: text,
  type: id,
  app: Schema.optionalKey(text),
});
export type DebugTarget = typeof DebugTarget.Type;
export const DebugOpen = Schema.Struct({
  bundleId: Schema.String.check(
    Schema.isPattern(/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/),
    Schema.isMaxLength(240),
  ),
});
export type DebugOpen = typeof DebugOpen.Type;
export const DebugAttach = Schema.Struct({ ...DebugEndpoint.fields, targetId: id });
export type DebugAttach = typeof DebugAttach.Type;
export const DebugIdentity = Schema.Struct({ sessionId: id });
export type DebugIdentity = typeof DebugIdentity.Type;
export const DebugSession = Schema.Struct({
  sessionId: id,
  endpoint: id,
  target: DebugTarget,
  state: Schema.Literals(["connected", "disconnected"]),
  paused: Schema.Boolean,
});
export type DebugSession = typeof DebugSession.Type;
export const DebugOpenResult = Schema.Struct({
  targets: Schema.Array(DebugTarget).check(Schema.isMaxLength(200)),
  session: Schema.NullOr(DebugSession),
});
export type DebugOpenResult = typeof DebugOpenResult.Type;
export const DebugEvent = Schema.Struct({
  sequence: NonNegativeInt,
  at: Schema.String,
  kind: Schema.Literals([
    "console",
    "exception",
    "network",
    "navigation",
    "debugger",
    "connection",
    "action",
  ]),
  level: Schema.Literals(["info", "warning", "error"]),
  text,
});
export type DebugEvent = typeof DebugEvent.Type;
export const DebugRead = Schema.Struct({
  ...DebugIdentity.fields,
  after: NonNegativeInt,
  screenshot: Schema.Boolean,
  afterImage: Schema.optionalKey(NonNegativeInt),
});
export type DebugRead = typeof DebugRead.Type;
export const DebugSnapshot = Schema.Struct({
  session: DebugSession,
  events: Schema.Array(DebugEvent).check(Schema.isMaxLength(100)),
  nextSequence: NonNegativeInt,
  dropped: NonNegativeInt,
  image: Schema.NullOr(Schema.String.check(Schema.isMaxLength(700000))),
  imageUnavailable: Schema.Boolean,
  imageSequence: Schema.optionalKey(NonNegativeInt),
  callFrames: Schema.Array(
    Schema.Struct({
      id,
      functionName: text,
      url: text,
      scriptId: id,
      line: NonNegativeInt,
      column: NonNegativeInt,
    }),
  ).check(Schema.isMaxLength(40)),
});
export type DebugSnapshot = typeof DebugSnapshot.Type;
// A deliberately small command surface. No navigation, cookies, headers, request bodies,
// arbitrary CDP forwarding. App launch is a separate exact bundle-ID operation.
export const DebugCommand = Schema.Struct({
  ...DebugIdentity.fields,
  action: Schema.Literals([
    "evaluate",
    "dom",
    "sources",
    "source",
    "breakpoint",
    "removeBreakpoint",
    "pause",
    "resume",
    "stepOver",
    "stepInto",
    "stepOut",
    "exceptions",
    "click",
    "type",
    "key",
    "scroll",
    "focus",
    "permissions",
  ]),
  expression: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16000))),
  contextId: Schema.optionalKey(NonNegativeInt),
  callFrameId: Schema.optionalKey(id),
  scriptId: Schema.optionalKey(id),
  url: Schema.optionalKey(text),
  line: Schema.optionalKey(NonNegativeInt),
  breakpointId: Schema.optionalKey(id),
  pauseOnExceptions: Schema.optionalKey(Schema.Literals(["none", "uncaught", "all"])),
  x: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  y: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  button: Schema.optionalKey(Schema.Literals(["left", "right"])),
  clickCount: Schema.optionalKey(Schema.Literals([1, 2])),
  text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
  key: Schema.optionalKey(
    Schema.Literals([
      "Enter",
      "Tab",
      "Escape",
      "Backspace",
      "Delete",
      "ArrowLeft",
      "ArrowRight",
      "ArrowDown",
      "ArrowUp",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "F6",
      "F7",
      "F8",
      "a",
      "c",
      "v",
      "x",
      "z",
      "n",
      "o",
      "s",
      "w",
      "f",
      "p",
    ]),
  ),
  modifiers: Schema.optionalKey(
    Schema.Array(Schema.Literals(["meta", "alt", "shift", "control"])).check(Schema.isMaxLength(4)),
  ),
  deltaX: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: -1200, maximum: 1200 }))),
  deltaY: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: -1200, maximum: 1200 }))),
});
export type DebugCommand = typeof DebugCommand.Type;
export const DebugCommandResult = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(240000)),
});
export type DebugCommandResult = typeof DebugCommandResult.Type;
export class ExternalDebugError extends Schema.TaggedError<ExternalDebugError>()(
  "ExternalDebugError",
  {
    reason: Schema.Literals([
      "invalid_endpoint",
      "unavailable",
      "target_missing",
      "busy",
      "session_missing",
      "disconnected",
      "timeout",
      "unsupported",
      "invalid_command",
      "too_large",
      "screen_permission",
      "accessibility_permission",
      "native_unavailable",
      "app_missing",
    ]),
  },
) {
  override get message() {
    const messages: Record<ExternalDebugError["reason"], string> = {
      app_missing:
        "This app is not installed on the session Mac. Check its bundle ID or choose an existing window.",
      invalid_endpoint:
        "Use mac://local for windows on the selected Mac, or an explicit loopback HTTP endpoint for a CDP runtime.",
      unavailable:
        "The selected Mac window or debug runtime is unavailable. Open it on the selected computer, then reconnect.",
      target_missing:
        "The selected runtime is no longer available. Refresh targets and select the add-in again.",
      busy: "This runtime is already attached, or the debugging limit has been reached. Disconnect an existing session first.",
      session_missing: "This debugging session is unavailable. Reconnect to the add-in.",
      disconnected: "The window or runtime disconnected. Open it again and refresh targets.",
      timeout: "The runtime did not respond before the deadline. It may be paused or unavailable.",
      unsupported: "This runtime does not support that debugging feature.",
      invalid_command: "This command needs valid input for the selected window or debugger.",
      too_large: "The runtime response exceeded the debugging size limit.",
      screen_permission:
        "Allow Screen & System Audio Recording for Cinderdeck or its server host in System Settings, then find windows again. No audio is captured.",
      accessibility_permission:
        "Allow Accessibility for Cinderdeck or its server host in System Settings to control the selected window. Viewing does not require Accessibility.",
      native_unavailable:
        "The Mac window helper is unavailable. Use the Mac desktop build, or build the helper with node scripts/deckhand/build-mac-external-debug.mjs for development. Requires macOS 14 or newer.",
    };
    return messages[this.reason];
  }
}
const error = Schema.Union([ExternalDebugError, EnvironmentAuthorizationError]);
const threadScope = { threadId: Schema.optionalKey(ThreadId) };
export const ExternalDebugRpcGroup = RpcGroup.make(
  Rpc.make(EXTERNAL_DEBUG_METHODS.discover, {
    payload: DebugEndpoint,
    success: Schema.Array(DebugTarget),
    error,
  }),
  Rpc.make(EXTERNAL_DEBUG_METHODS.open, {
    payload: Schema.Struct({ ...DebugOpen.fields, ...threadScope }),
    success: DebugOpenResult,
    error,
  }),
  Rpc.make(EXTERNAL_DEBUG_METHODS.attach, {
    payload: Schema.Struct({ ...DebugAttach.fields, ...threadScope }),
    success: DebugSession,
    error,
  }),
  Rpc.make(EXTERNAL_DEBUG_METHODS.sessions, {
    payload: Schema.Struct(threadScope),
    success: Schema.Array(DebugSession),
    error,
  }),
  Rpc.make(EXTERNAL_DEBUG_METHODS.read, {
    payload: Schema.Struct({ ...DebugRead.fields, ...threadScope }),
    success: DebugSnapshot,
    error,
  }),
  Rpc.make(EXTERNAL_DEBUG_METHODS.command, {
    payload: Schema.Struct({ ...DebugCommand.fields, ...threadScope }),
    success: DebugCommandResult,
    error,
  }),
  Rpc.make(EXTERNAL_DEBUG_METHODS.detach, {
    payload: Schema.Struct({ ...DebugIdentity.fields, ...threadScope }),
    success: Schema.Void,
    error,
  }),
);
