import * as C from "@cinderdeck/contracts/deckhand/externalDebugRpc";
import * as P from "@cinderdeck/contracts/deckhand/excelPerformance";
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
      "List transient external debugging sessions owned by this calling thread, including disconnected sessions. UI and agent share the same attachments. Use their sessionId to read screenshots/diagnostics and control the app or detach.",
  }).annotate(Tool.Readonly, true),
  Tool.make("deckhand_debug_targets", {
    ...base,
    parameters: C.DebugEndpoint,
    success: Schema.Array(C.DebugTarget),
    description:
      "Discover native windows on the selected Mac with endpoint mac://local. For Excel choose its window and its undocked Web Inspector as separate explicit targets. A loopback HTTP endpoint discovers CDP runtimes. Never opens or navigates an app.",
  }).annotate(Tool.Readonly, true),
  Tool.make("deckhand_debug_open", {
    ...base,
    parameters: C.DebugOpen,
    success: C.DebugOpenResult,
    description:
      "Open an installed Mac application by exact bundleId (Excel: com.microsoft.Excel) on this thread's computer. When one window is available, attach it to the calling thread and show it beside chat; multiple windows require deckhand_debug_attach with a chosen targetId. Reuses an existing attachment. Needs Screen Recording; does not open a document or change sign-in. After opening use deckhand_debug_read for screenshots, deckhand_debug_command for input, and read again to verify actual results. Only launch when requested by the user.",
  }).annotate(Tool.Readonly, false),
  Tool.make("deckhand_debug_attach", {
    ...base,
    parameters: C.DebugAttach,
    success: C.DebugSession,
    description:
      "Attach to an explicitly chosen existing runtime, preserving Excel/Office/Graph context. Sessions belong to this calling thread. Use deckhand_debug_open to launch an app when requested. Attachment preserves authentication and navigation. Detach when finished.",
  }).annotate(Tool.Readonly, false),
  Tool.make("deckhand_debug_read", {
    ...base,
    parameters: C.DebugRead,
    success: C.DebugSnapshot,
    description:
      "Read at most 100 diagnostics after a sequence cursor and an optional JPEG image from this calling thread's selected window. Pass imageSequence as afterImage for changed frames only. Native Mac debugging appears in the real Web Inspector image; structured call frames apply to CDP. Headers/cookies/bodies are excluded. Includes timestamped native input outcomes; accepted input is not proof of UI success, so verify with a subsequent read, which waits briefly for the repaint caused by the last input. For text such as cell values or console messages, deckhand_debug_command snapshot is more precise than the image. Output may contain app data.",
  }).annotate(Tool.Readonly, true),
  Tool.make("deckhand_debug_command", {
    ...base,
    parameters: C.DebugCommand,
    success: C.DebugCommandResult,
    description:
      "Inspect and control this calling thread's selected window. For a Mac window (Excel, its add-in task pane, or its undocked Web Inspector): snapshot returns an accessibility outline with [eN] refs, roles, names, values (cell address/formula bar, task pane DOM text, Inspector console messages) and normalized @x,y centers; pass ref to snapshot a subtree. press activates a ref; click (button, clickCount, modifiers) and move (hover) take ref or normalized x/y; drag goes from x/y to toX/toY (select a cell range); scroll takes x/y with pixel deltas; type sends text to the focused field; key sends a named key, letter, digit or punctuation with modifiers (e.g. F2 edit cell, F9 recalculate, meta+shift+l filter). focus brings the window forward; permissions reports Screen Recording/Accessibility. Snapshot reads without activating; input activates the selected window and requires Accessibility. Prefer snapshot refs over guessed coordinates, then deckhand_debug_read to verify. For add-in console/breakpoints, snapshot and control the real Web Inspector window. DOM/evaluate/source/breakpoint commands apply only to CDP targets. Expressions or native input can change live app/workbook data; stay within the user's task.",
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
  Tool.make("deckhand_excel_probe", {
    ...base,
    parameters: P.ProbeRequest,
    success: P.ProbeResult,
    description:
      "Structured telemetry from inside an Office add-in under development, for performance and debugging work alongside the Excel window tools. setup with an absolute projectRoot inspects the add-in repo (webpack or Vite, entries, manifests) and returns the two development-only edits to apply: a dev-server proxy for /__cinderdeck and a loader statement at the top of each page entry. Cinderdeck serves the probe itself; it is inert without Cinderdeck and absent from production builds. After editing, restart the dev server and reload the add-in. arm starts collecting for this thread and waits up to waitForClientMs for the page to connect; status reports connected pages (Office host/version, pending work) and a summary (Excel.run and context.sync round trips, fetch/XHR, resource downloads with phases and bytes, performance.measure timings, console errors, main-thread stalls); read pages events after a sequence cursor, optionally filtered by kinds; reset clears; disarm stops. Times are epoch ms comparable with window input and repaints. URLs lose queries; tokens are redacted; request bodies, headers and cookies are never read. Output may contain app data.",
  }).annotate(Tool.Readonly, false),
  Tool.make("deckhand_excel_benchmark", {
    ...base,
    parameters: P.BenchmarkRequest,
    success: P.BenchmarkResult,
    description:
      "Benchmark scripted interactions with an attached Excel window (sessionId from deckhand_debug_open/attach). start runs warmup + iterations of optional unmeasured setup steps then measured steps (click/press/type/key/drag/scroll/move/focus/wait, same fields as deckhand_debug_command; prefer snapshot refs). Each step lasts from native input dispatch until repaints, probe activity and outstanding Office.js/network work have been quiet for settleMs (default 600), or until a named probe mark/measure (until), or timeoutMs. Per step it reports duration, first repaint, Excel.run/context.sync counts and time, requests, downloaded bytes, measures, errors, longest main-thread stall, and CPU/memory of Excel plus its WebKit processes, as p50/p95 distributions. region limits repaint detection to part of the window (e.g. the task pane). Arms the probe automatically; without it only repaint and process metrics are available. Runs asynchronously: start returns a running report (pass waitMs to wait up to 55 s), get polls by runId, cancel stops, list shows saved reports. baselineId compares against an earlier report and flags regressions (median 10% and 20 ms slower). Input to the window is reserved for the run. Native input changes the live workbook; use a test document.",
  }).annotate(Tool.Readonly, false),
);
const actor = (mutation: boolean) =>
  (mutation ? readMutationCaller() : readCaller()).pipe(
    Effect.map(({ scope }) => Service.externalDebugThreadOwner(scope.threadId)),
  );
export const ExternalDebugStandardToolkit = Toolkit.make(
  ExternalDebugToolkit.tools.deckhand_debug_open,
  ExternalDebugToolkit.tools.deckhand_debug_targets,
  ExternalDebugToolkit.tools.deckhand_debug_sessions,
  ExternalDebugToolkit.tools.deckhand_debug_attach,
  ExternalDebugToolkit.tools.deckhand_debug_command,
  ExternalDebugToolkit.tools.deckhand_debug_detach,
  ExternalDebugToolkit.tools.deckhand_excel_probe,
  ExternalDebugToolkit.tools.deckhand_excel_benchmark,
);
export const ExternalDebugHandlersLive = ExternalDebugToolkit.toLayer({
  deckhand_excel_probe: (input) =>
    Effect.gen(function* () {
      const owner = yield* actor(true);
      return yield* (yield* Service.ExternalDebug).probe(owner, input);
    }).pipe(Effect.mapError(deckhandFailure)),
  deckhand_excel_benchmark: (input) =>
    Effect.gen(function* () {
      const owner = yield* actor(true);
      return yield* (yield* Service.ExternalDebug).benchmark(owner, input);
    }).pipe(Effect.mapError(deckhandFailure)),
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
  deckhand_debug_open: (input) =>
    Effect.gen(function* () {
      const owner = yield* actor(true);
      return yield* (yield* Service.ExternalDebug).open(owner, input);
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
