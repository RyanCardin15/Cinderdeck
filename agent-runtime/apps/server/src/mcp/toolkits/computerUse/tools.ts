// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as C from "@cinderdeck/contracts/deckhand/computerUse";
import { OrchestratorMcpFailure } from "@cinderdeck/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/unstable/ai";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Service from "../../../deckhand/ComputerUse.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import { readCaller, readMutationCaller } from "../../threadAccess.ts";

const base = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Invocation.McpInvocationContext,
    Service.ComputerUse,
    Threads.ThreadManagementService,
  ],
};

const background =
  "Works in the background: the app is not brought forward and the user's pointer and keyboard are not used; Cinderdeck shows the agent's own cursor. The person approves each app per conversation. Prefer a dedicated MCP, API or CLI when one exists; terminals and Cinderdeck cannot be controlled.";
const after = "Then call computer_get_app_state to verify the result before continuing.";

/** Drives a real app: it can change documents and app state. */
const actionTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.OpenWorld, true) as T;

export const ComputerUseToolkit = Toolkit.make(
  Tool.make("computer_list_apps", {
    ...base,
    // No `parameters`: an explicit empty Struct is not a valid MCP input schema.
    success: C.ComputerListAppsResult,
    description: `List installed and running Mac apps that computer use can target, with their bundle IDs and the Mac's permission status. ${background}`,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Idempotent, true),
  Tool.make("computer_get_app_state", {
    ...base,
    parameters: C.ComputerGetAppState,
    success: C.ComputerAppState,
    description: `Read a Mac app's window as an indexed accessibility tree plus a screenshot; launches the app in the background if it is not running. Call this first, and again after acting: later reads return only changes (unchanged elements keep their indexes). Use includeScreenshot:false for repeated text checks to avoid capture and image payloads; disableDiff:true restores the full tree. Act on elements by index with the other computer_* tools; use screenshot x/y only when no element fits. ${background}`,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.OpenWorld, true),
  actionTool(
    Tool.make("computer_click", {
      ...base,
      parameters: C.ComputerClick,
      success: C.ComputerActionResult,
      description: `Click an element by element_index (uses its accessibility action when it has one) or at screenshot x/y in the target window. ${after}`,
    }),
  ),
  actionTool(
    Tool.make("computer_type_text", {
      ...base,
      parameters: C.ComputerTypeText,
      success: C.ComputerActionResult,
      description: `Type text into the app's current focus, or into element_index after focusing it. Newlines press Return. ${after}`,
    }),
  ),
  actionTool(
    Tool.make("computer_press_key", {
      ...base,
      parameters: C.ComputerPressKey,
      success: C.ComputerActionResult,
      description: `Press a key or chord in the app, e.g. Return, Tab, Escape, super+s (Command-S), super+shift+z, Control_L+a. ${after}`,
    }),
  ),
  actionTool(
    Tool.make("computer_scroll", {
      ...base,
      parameters: C.ComputerScroll,
      success: C.ComputerActionResult,
      description: `Scroll a scrollable element (element_index), a screenshot point, or the window center by pages in a direction. ${after}`,
    }),
  ),
  actionTool(
    Tool.make("computer_set_value", {
      ...base,
      parameters: C.ComputerSetValue,
      success: C.ComputerActionResult,
      description: `Replace the value of an editable element (text field, slider, checkbox) directly through accessibility. Fastest way to fill a field. ${after}`,
    }),
  ),
  actionTool(
    Tool.make("computer_select_text", {
      ...base,
      parameters: C.ComputerSelectText,
      success: C.ComputerActionResult,
      description: `Select matching text inside an editable element, or place the insertion point before/after it (selection_type). Use prefix/suffix to pick one of several matches. ${after}`,
    }),
  ),
  actionTool(
    Tool.make("computer_perform_secondary_action", {
      ...base,
      parameters: C.ComputerSecondaryAction,
      success: C.ComputerActionResult,
      description: `Invoke one of an element's Secondary Actions listed in the state, such as Show Menu, Raise, Increment, or an app-specific action. ${after}`,
    }),
  ),
  actionTool(
    Tool.make("computer_drag", {
      ...base,
      parameters: C.ComputerDrag,
      success: C.ComputerActionResult,
      description: `Drag with the left button between two screenshot points in the target window. ${after}`,
    }),
  ),
  actionTool(
    Tool.make("computer_paste", {
      ...base,
      parameters: C.ComputerPaste,
      success: C.ComputerActionResult,
      description: `Paste text into the app's current focus through the clipboard (faster than typing long text), then restore the user's clipboard. ${after}`,
    }),
  ),
  actionTool(
    Tool.make("computer_activate_app", {
      ...base,
      parameters: C.ComputerApp,
      success: C.ComputerActionResult,
      description:
        "Last resort: bring the app's target window to the front of the user's screen. Use only when an app ignores background input; it interrupts the user.",
    }),
  ),
  actionTool(
    Tool.make("computer_script", {
      ...base,
      parameters: C.ComputerScript,
      success: C.ComputerScriptResult,
      description: `Run JavaScript (async; top-level await) that drives several computer-use steps in one call. Await every computer call before returning. Globals: computer.{list_apps, get_app_state, click, type_text, press_key, scroll, set_value, select_text, perform_secondary_action, drag, paste, activate_app}({...same arguments as the matching computer_* tools}), write(...values) for output, sleep(ms). get_app_state resolves to {app, name, text, diff, screenshot:{width,height}|null}; up to 3 latest screenshots are returned with the result. Failed calls reject with an Error whose reason is set. Values on globalThis persist between scripts in this conversation; reset:true clears them. Example: const s = await computer.get_app_state({app:"com.apple.TextEdit"}); write(s.text); ${background}`,
    }),
  ),
);

const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const isComputerUseError = Schema.is(C.ComputerUseError);
const toFailure = (cause: unknown) =>
  isMcpFailure(cause)
    ? cause
    : new OrchestratorMcpFailure({
        code: "invalid_request",
        message: isComputerUseError(cause)
          ? `${cause.reason}: ${cause.message}`
          : "The computer-use request could not be completed.",
      });

const actor = (mutation: boolean) =>
  (mutation ? readMutationCaller() : readCaller()).pipe(
    Effect.map(({ scope, caller }) => ({
      threadId: scope.threadId,
      label: (caller.title.trim() || "Agent").slice(0, 40),
    })),
  );

const act =
  <K extends Service.ComputerAction["kind"]>(kind: K) =>
  (input: Extract<Service.ComputerAction, { kind: K }>["input"]) =>
    Effect.gen(function* () {
      const who = yield* actor(true);
      return yield* (yield* Service.ComputerUse).act(who, {
        kind,
        input,
      } as Service.ComputerAction);
    }).pipe(Effect.mapError(toFailure));

export const ComputerUseHandlersLive = ComputerUseToolkit.toLayer({
  computer_list_apps: () =>
    Effect.gen(function* () {
      const who = yield* actor(false);
      return yield* (yield* Service.ComputerUse).listApps(who);
    }).pipe(Effect.mapError(toFailure)),
  computer_get_app_state: (input) =>
    Effect.gen(function* () {
      const who = yield* actor(false);
      return yield* (yield* Service.ComputerUse).getAppState(who, input);
    }).pipe(Effect.mapError(toFailure)),
  computer_click: act("click"),
  computer_type_text: act("type_text"),
  computer_press_key: act("press_key"),
  computer_scroll: act("scroll"),
  computer_set_value: act("set_value"),
  computer_select_text: act("select_text"),
  computer_perform_secondary_action: act("perform_secondary_action"),
  computer_drag: act("drag"),
  computer_paste: act("paste"),
  computer_activate_app: act("activate_app"),
  computer_script: (input) =>
    Effect.gen(function* () {
      const who = yield* actor(true);
      return yield* (yield* Service.ComputerUse).script(who, input);
    }).pipe(Effect.mapError(toFailure)),
});

/** Tools returned as plain JSON; the image-bearing ones are registered by hand. */
export const ComputerUseStandardToolkit = Toolkit.make(
  ComputerUseToolkit.tools.computer_list_apps,
  ComputerUseToolkit.tools.computer_click,
  ComputerUseToolkit.tools.computer_type_text,
  ComputerUseToolkit.tools.computer_press_key,
  ComputerUseToolkit.tools.computer_scroll,
  ComputerUseToolkit.tools.computer_set_value,
  ComputerUseToolkit.tools.computer_select_text,
  ComputerUseToolkit.tools.computer_perform_secondary_action,
  ComputerUseToolkit.tools.computer_drag,
  ComputerUseToolkit.tools.computer_paste,
  ComputerUseToolkit.tools.computer_activate_app,
);

const isState = Schema.is(C.ComputerAppState);
const isScript = Schema.is(C.ComputerScriptResult);
const failureResult = (value: unknown) => {
  const failure =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return new McpSchema.CallToolResult({
    isError: true,
    structuredContent: failure,
    content: [
      {
        type: "text",
        text: typeof failure.message === "string" ? failure.message : JSON.stringify(failure),
      },
    ],
  });
};
const image = (shot: C.ComputerScreenshot) => ({
  type: "image" as const,
  mimeType: shot.mimeType,
  data: new Uint8Array(Buffer.from(shot.data, "base64")),
});

/** The accessibility text leads; the screenshot follows as an image block. */
export function computerStateMcpResult(value: unknown): McpSchema.CallToolResult {
  if (!isState(value)) return failureResult(value);
  const { screenshot, ...rest } = value;
  const metadata = {
    ...rest,
    screenshot: screenshot ? { width: screenshot.width, height: screenshot.height } : null,
  };
  return new McpSchema.CallToolResult({
    isError: false,
    structuredContent: metadata,
    content: [{ type: "text", text: value.text }, ...(screenshot ? [image(screenshot)] : [])],
  });
}

export function computerScriptMcpResult(value: unknown): McpSchema.CallToolResult {
  if (!isScript(value)) return failureResult(value);
  return new McpSchema.CallToolResult({
    isError: !value.ok,
    structuredContent: {
      ok: value.ok,
      output: value.output,
      screenshots: value.screenshots.length,
    },
    content: [{ type: "text", text: value.output }, ...value.screenshots.map(image)],
  });
}
