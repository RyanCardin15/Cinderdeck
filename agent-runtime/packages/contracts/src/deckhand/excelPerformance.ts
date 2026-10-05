import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { NativeInputFields, NormalizedRegion } from "./externalDebugInput.ts";

// Excel add-in performance: a development-only probe inside the add-in page reports
// Office.js, network, timing and console activity; the native window helper reports
// repaint and process cost; the benchmark runner correlates them per scripted step.
const id = TrimmedNonEmptyString.check(Schema.isMaxLength(240));
const name = Schema.String.check(Schema.isMaxLength(500));
const text = Schema.String.check(Schema.isMaxLength(4000));
const milliseconds = Schema.Number.check(Schema.isFinite());

export const EXCEL_PROBE_DEFAULT_PORT = 47823;
export const EXCEL_PROBE_PATH = "/__cinderdeck";
export const EXCEL_PROBE_SCRIPT_PATH = `${EXCEL_PROBE_PATH}/excel-probe.js`;
export const EXCEL_PROBE_EVENTS_PATH = `${EXCEL_PROBE_PATH}/excel-probe/events`;
// Browsers cannot send this header cross-site without a preflight the listener refuses.
export const EXCEL_PROBE_HEADER = "x-cinderdeck-probe";

export const ProbeEventKind = Schema.Literals([
  "probe",
  "ready",
  "run",
  "sync",
  "fetch",
  "xhr",
  "resource",
  "navigation",
  "paint",
  "mark",
  "measure",
  "console",
  "error",
  "jank",
]);
export type ProbeEventKind = typeof ProbeEventKind.Type;
// Times are epoch milliseconds on the add-in's Mac, comparable with native input and
// repaint timestamps.
export const ProbeEvent = Schema.Struct({
  sequence: NonNegativeInt,
  client: id,
  kind: ProbeEventKind,
  start: milliseconds,
  end: Schema.optionalKey(milliseconds),
  name: Schema.optionalKey(name),
  detail: Schema.optionalKey(text),
  status: Schema.optionalKey(Schema.Int),
  bytes: Schema.optionalKey(NonNegativeInt),
  count: Schema.optionalKey(NonNegativeInt),
  ok: Schema.optionalKey(Schema.Boolean),
  level: Schema.optionalKey(Schema.Literals(["info", "warning", "error"])),
});
export type ProbeEvent = typeof ProbeEvent.Type;
export const ProbeClient = Schema.Struct({
  id,
  page: name,
  title: name,
  office: Schema.NullOr(name),
  connected: Schema.Boolean,
  firstSeen: milliseconds,
  lastSeen: milliseconds,
  pendingSyncs: NonNegativeInt,
  pendingRequests: NonNegativeInt,
  loadedAfterMs: Schema.NullOr(milliseconds),
  droppedEvents: NonNegativeInt,
});
export type ProbeClient = typeof ProbeClient.Type;
export const Distribution = Schema.Struct({
  count: NonNegativeInt,
  total: milliseconds,
  min: milliseconds,
  p50: milliseconds,
  p95: milliseconds,
  max: milliseconds,
  mean: milliseconds,
});
export type Distribution = typeof Distribution.Type;
export const NamedDistribution = Schema.Struct({ name, ...Distribution.fields });
export type NamedDistribution = typeof NamedDistribution.Type;
export const ProbeSummary = Schema.Struct({
  runs: Distribution,
  syncs: Distribution,
  syncFailures: NonNegativeInt,
  requests: Distribution,
  requestFailures: NonNegativeInt,
  resources: Distribution,
  transferBytes: NonNegativeInt,
  errors: NonNegativeInt,
  warnings: NonNegativeInt,
  jank: Distribution,
  measures: Schema.Array(NamedDistribution).check(Schema.isMaxLength(100)),
});
export type ProbeSummary = typeof ProbeSummary.Type;
export const ProbeStatus = Schema.Struct({
  armed: Schema.Boolean,
  listening: Schema.Boolean,
  port: NonNegativeInt,
  unavailable: Schema.NullOr(text),
  clients: Schema.Array(ProbeClient).check(Schema.isMaxLength(20)),
  nextSequence: NonNegativeInt,
  dropped: NonNegativeInt,
  summary: ProbeSummary,
});
export type ProbeStatus = typeof ProbeStatus.Type;
export const ProbeSetup = Schema.Struct({
  projectRoot: text,
  bundler: Schema.Literals(["webpack", "vite", "unknown"]),
  configFile: Schema.NullOr(text),
  entryFiles: Schema.Array(text).check(Schema.isMaxLength(20)),
  manifests: Schema.Array(text).check(Schema.isMaxLength(20)),
  proxyConfigured: Schema.Boolean,
  loaderInstalled: Schema.Boolean,
  proxySnippet: text,
  loaderSnippet: text,
  instructions: text,
});
export type ProbeSetup = typeof ProbeSetup.Type;
// The two development-only edits an add-in repository needs. Cinderdeck serves the probe.
export function excelProbeSnippets(
  bundler: ProbeSetup["bundler"],
  port = EXCEL_PROBE_DEFAULT_PORT,
) {
  const target = `\`http://127.0.0.1:\${process.env.CINDERDECK_EXCEL_PROBE_PORT || ${port}}\``;
  const proxySnippet =
    bundler === "vite"
      ? `// Cinderdeck Excel performance probe (development only).
server: {
  proxy: { "${EXCEL_PROBE_PATH}": { target: ${target} } },
},`
      : `// Cinderdeck Excel performance probe (development only). Merge into devServer.proxy
// if it already exists; logLevel silences errors while Cinderdeck is not running.
devServer: {
  proxy: [{ context: ["${EXCEL_PROBE_PATH}"], target: ${target}, logLevel: "silent" }],
},`;
  const condition =
    bundler === "vite" ? "import.meta.env.DEV" : `process.env.NODE_ENV !== "production"`;
  const loaderSnippet = `// Cinderdeck Excel performance probe: development builds only; inert without Cinderdeck.
if (${condition} && typeof document !== "undefined") {
  const probe = document.createElement("script");
  probe.src = "${EXCEL_PROBE_SCRIPT_PATH}";
  document.head.appendChild(probe);
}`;
  return { proxySnippet, loaderSnippet };
}

export const ProbeRequest = Schema.Struct({
  action: Schema.Literals(["status", "arm", "disarm", "read", "reset", "setup"]),
  after: Schema.optionalKey(NonNegativeInt),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
  kinds: Schema.optionalKey(Schema.Array(ProbeEventKind).check(Schema.isMaxLength(14))),
  projectRoot: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
  waitForClientMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30000 })),
  ),
});
export type ProbeRequest = typeof ProbeRequest.Type;
export const ProbeResult = Schema.Struct({
  status: ProbeStatus,
  events: Schema.Array(ProbeEvent).check(Schema.isMaxLength(500)),
  setup: Schema.NullOr(ProbeSetup),
});
export type ProbeResult = typeof ProbeResult.Type;

export const BenchmarkStep = Schema.Struct({
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  action: Schema.Literals([
    "click",
    "press",
    "type",
    "key",
    "drag",
    "scroll",
    "move",
    "focus",
    "wait",
  ]),
  ...NativeInputFields,
  // For "wait": a fixed pause, e.g. to let a server cache expire between iterations.
  waitMs: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60000 }))),
  // End the step at the first matching probe mark or performance.measure after the
  // input, instead of when paint and probe activity settle.
  until: Schema.optionalKey(
    Schema.Struct({
      mark: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
      measure: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
    }),
  ),
  settleMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 10000 })),
  ),
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 500, maximum: 300000 })),
  ),
});
export type BenchmarkStep = typeof BenchmarkStep.Type;
export const BenchmarkSample = Schema.Struct({
  iteration: NonNegativeInt,
  label: Schema.String,
  start: milliseconds,
  duration: milliseconds,
  timedOut: Schema.Boolean,
  firstPaint: Schema.NullOr(milliseconds),
  lastPaint: Schema.NullOr(milliseconds),
  runs: NonNegativeInt,
  syncs: NonNegativeInt,
  syncTime: milliseconds,
  syncFailures: NonNegativeInt,
  requests: NonNegativeInt,
  requestTime: milliseconds,
  requestFailures: NonNegativeInt,
  resources: NonNegativeInt,
  transferBytes: NonNegativeInt,
  errors: NonNegativeInt,
  jankMax: milliseconds,
  cpuAverage: Schema.NullOr(milliseconds),
  cpuPeak: Schema.NullOr(milliseconds),
  memoryPeak: Schema.NullOr(NonNegativeInt),
  memoryDelta: Schema.NullOr(Schema.Int),
  measures: Schema.Array(Schema.Struct({ name, duration: milliseconds })).check(
    Schema.isMaxLength(50),
  ),
});
export type BenchmarkSample = typeof BenchmarkSample.Type;
export const BenchmarkStepStats = Schema.Struct({
  label: Schema.String,
  samples: NonNegativeInt,
  timedOut: NonNegativeInt,
  duration: Distribution,
  firstPaint: Schema.NullOr(Distribution),
  syncs: Distribution,
  syncTime: Distribution,
  requests: Distribution,
  requestTime: Distribution,
  transferBytes: Distribution,
  errors: NonNegativeInt,
  jankMax: Distribution,
  cpuAverage: Schema.NullOr(Distribution),
  memoryPeak: Schema.NullOr(Distribution),
  measures: Schema.Array(NamedDistribution).check(Schema.isMaxLength(50)),
});
export type BenchmarkStepStats = typeof BenchmarkStepStats.Type;
export const BenchmarkComparison = Schema.Struct({
  baselineId: id,
  baselineName: Schema.String,
  steps: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      baselineP50: milliseconds,
      currentP50: milliseconds,
      baselineP95: milliseconds,
      currentP95: milliseconds,
      deltaP50Percent: milliseconds,
      deltaP95Percent: milliseconds,
      verdict: Schema.Literals(["regression", "improvement", "unchanged"]),
    }),
  ).check(Schema.isMaxLength(40)),
});
export type BenchmarkComparison = typeof BenchmarkComparison.Type;
export const BenchmarkReport = Schema.Struct({
  id,
  name: Schema.String,
  state: Schema.Literals(["running", "completed", "failed", "cancelled"]),
  createdAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  progress: Schema.Struct({
    iteration: NonNegativeInt,
    iterations: NonNegativeInt,
    step: Schema.String,
  }),
  target: Schema.Struct({ app: Schema.String, title: Schema.String }),
  clients: Schema.Array(ProbeClient).check(Schema.isMaxLength(20)),
  iterations: NonNegativeInt,
  warmup: NonNegativeInt,
  region: Schema.NullOr(NormalizedRegion),
  paintMeasured: Schema.Boolean,
  processesMeasured: NonNegativeInt,
  steps: Schema.Array(BenchmarkStepStats).check(Schema.isMaxLength(40)),
  samples: Schema.Array(BenchmarkSample).check(Schema.isMaxLength(2000)),
  warnings: Schema.Array(Schema.String).check(Schema.isMaxLength(50)),
  error: Schema.NullOr(Schema.String),
  comparison: Schema.NullOr(BenchmarkComparison),
});
export type BenchmarkReport = typeof BenchmarkReport.Type;
export const BenchmarkListing = Schema.Struct({
  id,
  name: Schema.String,
  state: BenchmarkReport.fields.state,
  createdAt: Schema.String,
  iterations: NonNegativeInt,
  steps: Schema.Array(
    Schema.Struct({ label: Schema.String, p50: milliseconds, p95: milliseconds }),
  ).check(Schema.isMaxLength(40)),
  regressions: NonNegativeInt,
});
export type BenchmarkListing = typeof BenchmarkListing.Type;
export const BenchmarkRequest = Schema.Struct({
  action: Schema.Literals(["start", "get", "list", "cancel"]),
  sessionId: Schema.optionalKey(id),
  runId: Schema.optionalKey(id),
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  iterations: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  warmup: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
  // Unmeasured steps before each iteration, e.g. selecting a cell or clearing a sheet.
  setup: Schema.optionalKey(Schema.Array(BenchmarkStep).check(Schema.isMaxLength(20))),
  steps: Schema.optionalKey(Schema.Array(BenchmarkStep).check(Schema.isMaxLength(20))),
  // Only repaints intersecting this window region count, e.g. the task pane.
  region: Schema.optionalKey(NormalizedRegion),
  settleMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 10000 })),
  ),
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 500, maximum: 300000 })),
  ),
  baselineId: Schema.optionalKey(id),
  // Raw per-iteration samples are omitted from results unless requested.
  includeSamples: Schema.optionalKey(Schema.Boolean),
  waitMs: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 55000 }))),
});
export type BenchmarkRequest = typeof BenchmarkRequest.Type;
export const BenchmarkResult = Schema.Struct({
  report: Schema.NullOr(BenchmarkReport),
  reports: Schema.Array(BenchmarkListing).check(Schema.isMaxLength(100)),
});
export type BenchmarkResult = typeof BenchmarkResult.Type;
