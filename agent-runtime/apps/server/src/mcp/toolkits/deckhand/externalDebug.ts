import * as C from "@cinderdeck/contracts/deckhand/externalDebugRpc";
import { OrchestratorMcpFailure } from "@cinderdeck/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Service from "../../../deckhand/ExternalDebug.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import { readCaller, readMutationCaller } from "../../threadAccess.ts";
import { deckhandFailure } from "../../DeckhandMcpAccess.ts";
const base = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Invocation.McpInvocationContext,
    Service.ExternalDebug,
    Threads.ThreadManagementService,
  ],
};
export const ExternalDebugToolkit = Toolkit.make(
  Tool.make("deckhand_debug_sessions", {
    ...base,
    parameters: Schema.Struct({ includeDisconnected: Schema.optionalKey(Schema.Boolean) }),
    success: Schema.Array(C.DebugSession),
    description:
      "List transient external debugging sessions owned by this calling thread, including disconnected sessions. Use their saved sessionId to continue diagnostics or detach.",
  }).annotate(Tool.Readonly, true),
  Tool.make("deckhand_debug_targets", {
    ...base,
    parameters: C.DebugEndpoint,
    success: Schema.Array(C.DebugTarget),
    description:
      "Discover native windows on the selected Mac with endpoint mac://local. For Excel choose its window and its undocked Web Inspector as separate explicit targets. A loopback HTTP endpoint discovers CDP runtimes. Never opens or navigates an app.",
  }).annotate(Tool.Readonly, true),
  Tool.make("deckhand_debug_attach", {
    ...base,
    parameters: C.DebugAttach,
    success: C.DebugSession,
    description:
      "Attach to an explicitly chosen existing runtime, preserving Excel/Office/Graph context. Sessions belong to this calling thread. Never launch Excel, replace authentication, or navigate the add-in. Detach when finished.",
  }).annotate(Tool.Readonly, false),
  Tool.make("deckhand_debug_read", {
    ...base,
    parameters: C.DebugRead,
    success: C.DebugSnapshot,
    description:
      "Read at most 100 diagnostics after a sequence cursor and an optional JPEG image from this calling thread's selected window. Pass imageSequence as afterImage for changed frames only. Native Mac debugging appears in the real Web Inspector image; structured call frames apply to CDP. Headers/cookies/bodies are excluded. Output may contain app data.",
  }).annotate(Tool.Readonly, true),
  Tool.make("deckhand_debug_command", {
    ...base,
    parameters: C.DebugCommand,
    success: C.DebugCommandResult,
    description:
      "For a Mac window use click/scroll with normalized x/y, type text, key plus modifiers, focus, or permissions. Controls activate only the selected window on its Mac; requires Accessibility. Use the actual Web Inspector window for console and breakpoint debugging. DOM/evaluate/source/breakpoint commands apply only to CDP targets. Expressions or native input can change live app/workbook data; stay within the user's task.",
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true),
  Tool.make("deckhand_debug_detach", {
    ...base,
    parameters: C.DebugIdentity,
    success: Schema.Void,
    description:
      "Release this calling thread's connection without closing Excel or its add-in. Mac mirroring ends capture/control but leaves native Inspector breakpoints and paused execution intact; resume in the Inspector before disconnecting when needed. CDP detach releases this client's debugger and breakpoints.",
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, true),
);
const actor = (mutation: boolean) =>
  (mutation ? readMutationCaller() : readCaller()).pipe(
    Effect.map(({ scope }) => Service.externalDebugThreadOwner(scope.threadId)),
  );
export const ExternalDebugStandardToolkit = Toolkit.make(
  ExternalDebugToolkit.tools.deckhand_debug_targets,
  ExternalDebugToolkit.tools.deckhand_debug_sessions,
  ExternalDebugToolkit.tools.deckhand_debug_attach,
  ExternalDebugToolkit.tools.deckhand_debug_command,
  ExternalDebugToolkit.tools.deckhand_debug_detach,
);
export const ExternalDebugHandlersLive = ExternalDebugToolkit.toLayer({
  deckhand_debug_sessions: (input) =>
    Effect.gen(function* () {
      const owner = yield* actor(false);
      const sessions = yield* (yield* Service.ExternalDebug).sessions(owner);
      return input.includeDisconnected === false
        ? sessions.filter((session) => session.state === "connected")
        : sessions;
    }).pipe(Effect.mapError(deckhandFailure)),
  deckhand_debug_targets: (input) =>
    Effect.gen(function* () {
      yield* readCaller();
      return yield* (yield* Service.ExternalDebug).discover(input);
    }).pipe(Effect.mapError(deckhandFailure)),
  deckhand_debug_attach: (input) =>
    Effect.gen(function* () {
      const owner = yield* actor(true);
      return yield* (yield* Service.ExternalDebug).attach(owner, input);
    }).pipe(Effect.mapError(deckhandFailure)),
  deckhand_debug_read: (input) =>
    Effect.gen(function* () {
      const owner = yield* actor(false);
      return yield* (yield* Service.ExternalDebug).read(owner, input);
    }).pipe(Effect.mapError(deckhandFailure)),
  deckhand_debug_command: (input) =>
    Effect.gen(function* () {
      const owner = yield* actor(true);
      return yield* (yield* Service.ExternalDebug).command(owner, input);
    }).pipe(Effect.mapError(deckhandFailure)),
  deckhand_debug_detach: (input) =>
    Effect.gen(function* () {
      const owner = yield* actor(true);
      return yield* (yield* Service.ExternalDebug).detach(owner, input);
    }).pipe(Effect.mapError(deckhandFailure)),
});
