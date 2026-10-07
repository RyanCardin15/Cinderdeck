// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalTimersInEffect:off
// @effect-diagnostics preferSchemaOverJson:off
// Scripted, repeated Excel interactions measured across three clocks that share wall time:
// native input dispatch, native repaints, and the add-in probe's Office.js/network events.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import type {
  BenchmarkComparison,
  BenchmarkListing,
  BenchmarkReport,
  BenchmarkSample,
  BenchmarkStep,
  BenchmarkStepStats,
  ProbeClient,
  ProbeEvent,
} from "@cinderdeck/contracts/deckhand/excelPerformance";
import { BenchmarkReport as BenchmarkReportSchema } from "@cinderdeck/contracts/deckhand/excelPerformance";
import type { NormalizedRegion } from "@cinderdeck/contracts/deckhand/externalDebugInput";
import { distribution, duration, isFailure, isRequest, namedDistributions } from "./ExcelProbe.ts";

export type RepaintChange = {
  t: number;
  area: number;
  rects: ReadonlyArray<ReadonlyArray<number>>;
};
export type ProcessSample = { t: number; cpu: number; memory: number; processes: number };
export interface BenchmarkDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  // Dispatches one native input and returns its wall-clock dispatch time.
  act(step: BenchmarkStep): Promise<number>;
  timeline(since: number): Promise<{ changes: RepaintChange[]; samples: ProcessSample[] }>;
  probeEvents(from: number, to: number): ProbeEvent[];
  probeActivity(): { clients: number; pending: number; deliveredThrough: number | null };
  probeClients(): ProbeClient[];
  cancelled(): boolean;
  progress(iteration: number, step: string): void;
}
export type BenchmarkPlan = {
  iterations: number;
  warmup: number;
  setup: ReadonlyArray<BenchmarkStep>;
  steps: ReadonlyArray<BenchmarkStep>;
  region: NormalizedRegion | null;
  settleMs: number;
  timeoutMs: number;
  paint: boolean;
};
// Caret blinks and cursor-sized repaints would otherwise never let a step settle.
const MIN_CHANGE_AREA = 0.0005;
const POLL_MS = 100;

const intersects = (rect: ReadonlyArray<number>, region: NormalizedRegion) => {
  const [x = 0, y = 0, width = 0, height = 0] = rect;
  return (
    x < region.x + region.width &&
    x + width > region.x &&
    y < region.y + region.height &&
    y + height > region.y
  );
};
export function significantChanges(
  changes: ReadonlyArray<RepaintChange>,
  region: NormalizedRegion | null,
) {
  return changes.filter(
    (change) =>
      change.area >= MIN_CHANGE_AREA &&
      (!region || change.rects.some((rect) => intersects(rect, region))),
  );
}

// Background repaints, such as Excel redrawing its grid while idle, are learned per step
// from a pre-input observation on a coarse grid. Later repaints only count when they touch
// a cell that was quiet before the input.
const GRID = 24;
export type NoiseMask = { cells: ReadonlySet<number>; coverage: number };
const cellsOf = (rect: ReadonlyArray<number>, dilate: number) => {
  const [x = 0, y = 0, width = 0, height = 0] = rect;
  const clamp = (value: number) => Math.max(0, Math.min(GRID - 1, value));
  const cells: number[] = [];
  const left = clamp(Math.floor(x * GRID) - dilate),
    right = clamp(Math.ceil((x + width) * GRID) - 1 + dilate),
    top = clamp(Math.floor(y * GRID) - dilate),
    bottom = clamp(Math.ceil((y + height) * GRID) - 1 + dilate);
  for (let row = top; row <= bottom; row++)
    for (let column = left; column <= right; column++) cells.push(row * GRID + column);
  return cells;
};
function noiseMask(changes: ReadonlyArray<RepaintChange>): NoiseMask {
  const cells = new Set<number>();
  for (const change of changes)
    for (const rect of change.rects) for (const cell of cellsOf(rect, 1)) cells.add(cell);
  return { cells, coverage: cells.size / (GRID * GRID) };
}
const relevantChange = (change: RepaintChange, mask: NoiseMask) =>
  change.rects.some((rect) => cellsOf(rect, 0).some((cell) => !mask.cells.has(cell)));
// When background repaints cover most of the window, repaints cannot show completion.
const UNUSABLE_COVERAGE = 0.9;

export type StepOutcome = {
  start: number;
  end: number;
  timedOut: boolean;
  paints: RepaintChange[];
  // Share of the window that repainted before input and was ignored; null without paint.
  backgroundCoverage: number | null;
  paintIgnored: boolean;
};
const bounds = (changes: ReadonlyArray<RepaintChange>) => {
  const rects = changes.flatMap((change) => change.rects);
  if (!rects.length) return null;
  const left = Math.min(...rects.map((rect) => rect[0] ?? 0)),
    top = Math.min(...rects.map((rect) => rect[1] ?? 0)),
    right = Math.max(...rects.map((rect) => (rect[0] ?? 0) + (rect[2] ?? 0))),
    bottom = Math.max(...rects.map((rect) => (rect[1] ?? 0) + (rect[3] ?? 0)));
  const fixed = (value: number) => Math.round(value * 100) / 100;
  return { x: fixed(left), y: fixed(top), width: fixed(right - left), height: fixed(bottom - top) };
};
// Waits until a step's effects end: no relevant repaint, probe activity or outstanding
// Office/network work for settleMs, with every probe event up to then delivered. A
// step with `until` ends at its named mark or measure instead.
async function measureStep(
  deps: BenchmarkDeps,
  plan: BenchmarkPlan,
  step: BenchmarkStep,
): Promise<StepOutcome> {
  const settle = step.settleMs ?? plan.settleMs;
  const timeout = step.timeoutMs ?? plan.timeoutMs;
  if (step.action === "wait") {
    const start = deps.now();
    await deps.sleep(step.waitMs ?? 0);
    return {
      start,
      end: deps.now(),
      timedOut: false,
      paints: [],
      backgroundCoverage: null,
      paintIgnored: false,
    };
  }
  let mask: NoiseMask | null = null;
  if (plan.paint) {
    // Any background repaint frequent enough to prevent settling recurs within settleMs.
    const observed = deps.now();
    await deps.sleep(settle);
    mask = noiseMask(significantChanges((await deps.timeline(observed)).changes, plan.region));
  }
  const paintIgnored = (mask?.coverage ?? 0) > UNUSABLE_COVERAGE;
  const start = await deps.act(step);
  const paints: RepaintChange[] = [];
  const outcome = (end: number, timedOut: boolean): StepOutcome => ({
    start,
    end,
    timedOut,
    paints,
    backgroundCoverage: mask ? Math.round(mask.coverage * 1000) / 1000 : null,
    paintIgnored,
  });
  let since = start - 1;
  while (true) {
    if (deps.cancelled()) throw new Error("cancelled");
    await deps.sleep(POLL_MS);
    const now = deps.now();
    if (plan.paint && !paintIgnored) {
      const timeline = await deps.timeline(since);
      for (const change of significantChanges(timeline.changes, plan.region))
        if (change.t >= start && (!mask || relevantChange(change, mask))) paints.push(change);
      since = Math.max(since, ...timeline.changes.map((change) => change.t));
    }
    const events = deps.probeEvents(start - 5, now);
    if (step.until?.measure || step.until?.mark) {
      const match = events.find((event) =>
        step.until?.measure
          ? event.kind === "measure" &&
            event.name === step.until.measure &&
            event.start >= start - 50
          : event.kind === "mark" && event.name === step.until?.mark && event.start >= start,
      );
      if (match) return outcome(match.end ?? match.start, false);
    } else {
      const activity = deps.probeActivity();
      const last = Math.max(
        start,
        ...paints.map((change) => change.t),
        ...events
          .filter((event) => event.kind !== "jank" && event.kind !== "probe")
          .map((event) => event.end ?? event.start),
      );
      const delivered = activity.clients === 0 || (activity.deliveredThrough ?? 0) >= last;
      if (activity.pending === 0 && delivered && now - last >= settle) return outcome(last, false);
    }
    if (now - start >= timeout) return outcome(now, true);
  }
}

async function sampleStep(
  deps: BenchmarkDeps,
  outcome: StepOutcome,
  iteration: number,
  label: string,
  plan: BenchmarkPlan,
): Promise<BenchmarkSample> {
  const { start, end } = outcome;
  const paints = outcome.paints.map((change) => change.t);
  const events = deps.probeEvents(start - 5, end + 5);
  const of = (kind: ProbeEvent["kind"]) => events.filter((event) => event.kind === kind);
  const syncs = of("sync");
  const requests = events.filter(isRequest);
  const resources = of("resource");
  const samples = plan.paint
    ? (await deps.timeline(start - 250)).samples.filter((sample) => sample.t <= end + 250)
    : [];
  const during = samples.filter((sample) => sample.t >= start);
  const cpu = during.map((sample) => sample.cpu);
  const memory = samples.map((sample) => sample.memory);
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    iteration,
    label,
    start,
    duration: round(end - start),
    timedOut: outcome.timedOut,
    firstPaint: paints.length ? round(Math.min(...paints) - start) : null,
    lastPaint: paints.length ? round(Math.max(...paints) - start) : null,
    runs: of("run").length,
    syncs: syncs.length,
    syncTime: round(syncs.reduce((sum, event) => sum + duration(event), 0)),
    syncFailures: syncs.filter((event) => event.ok === false).length,
    requests: requests.length,
    requestTime: round(requests.reduce((sum, event) => sum + duration(event), 0)),
    requestFailures: requests.filter((event) => event.ok === false).length,
    resources: resources.length,
    transferBytes: resources.reduce((sum, event) => sum + (event.bytes ?? 0), 0),
    errors: events.filter(isFailure).length,
    jankMax: round(Math.max(0, ...of("jank").map(duration))),
    cpuAverage: cpu.length ? round(cpu.reduce((sum, value) => sum + value, 0) / cpu.length) : null,
    cpuPeak: cpu.length ? round(Math.max(...cpu)) : null,
    memoryPeak: memory.length ? Math.round(Math.max(...memory)) : null,
    memoryDelta: memory.length > 1 ? Math.round(memory.at(-1)! - memory[0]!) : null,
    measures: of("measure")
      .slice(0, 50)
      .map((event) => ({ name: event.name ?? "", duration: round(duration(event)) })),
  };
}

function stepStats(label: string, samples: ReadonlyArray<BenchmarkSample>): BenchmarkStepStats {
  const pick = (read: (sample: BenchmarkSample) => number) => distribution(samples.map(read));
  const optional = (read: (sample: BenchmarkSample) => number | null) => {
    const values = samples.flatMap((sample) => read(sample) ?? []);
    return values.length ? distribution(values) : null;
  };
  return {
    label,
    samples: samples.length,
    timedOut: samples.filter((sample) => sample.timedOut).length,
    duration: pick((sample) => sample.duration),
    firstPaint: optional((sample) => sample.firstPaint),
    syncs: pick((sample) => sample.syncs),
    syncTime: pick((sample) => sample.syncTime),
    requests: pick((sample) => sample.requests),
    requestTime: pick((sample) => sample.requestTime),
    transferBytes: pick((sample) => sample.transferBytes),
    errors: samples.reduce((sum, sample) => sum + sample.errors, 0),
    jankMax: pick((sample) => sample.jankMax),
    cpuAverage: optional((sample) => sample.cpuAverage),
    memoryPeak: optional((sample) => sample.memoryPeak),
    measures: namedDistributions(
      samples.flatMap((sample) =>
        sample.measures.map((m) => ({ name: m.name, value: m.duration })),
      ),
      50,
    ),
  };
}

// A step regresses when its median is both 10% and 20 ms slower than the baseline's.
export function compareReports(
  current: ReadonlyArray<BenchmarkStepStats>,
  baseline: BenchmarkReport,
): BenchmarkComparison {
  const percent = (from: number, to: number) =>
    from > 0 ? Math.round(((to - from) / from) * 1000) / 10 : 0;
  return {
    baselineId: baseline.id,
    baselineName: baseline.name,
    steps: current.flatMap((step) => {
      const before = baseline.steps.find((entry) => entry.label === step.label);
      if (!before || !before.samples || !step.samples) return [];
      const delta = step.duration.p50 - before.duration.p50;
      const ratio = percent(before.duration.p50, step.duration.p50);
      return [
        {
          label: step.label,
          baselineP50: before.duration.p50,
          currentP50: step.duration.p50,
          baselineP95: before.duration.p95,
          currentP95: step.duration.p95,
          deltaP50Percent: ratio,
          deltaP95Percent: percent(before.duration.p95, step.duration.p95),
          verdict:
            delta > 20 && ratio > 10
              ? ("regression" as const)
              : delta < -20 && ratio < -10
                ? ("improvement" as const)
                : ("unchanged" as const),
        },
      ];
    }),
  };
}

export async function runBenchmark(
  deps: BenchmarkDeps,
  plan: BenchmarkPlan,
  report: BenchmarkReport,
  update: (report: BenchmarkReport) => void,
): Promise<BenchmarkReport> {
  let current = report;
  const samples: BenchmarkSample[] = [];
  const warnings = new Set(report.warnings);
  const finish = (patch: Partial<BenchmarkReport>) => {
    const labels = [...new Set(plan.steps.map((step) => step.label))];
    current = {
      ...current,
      ...patch,
      clients: deps.probeClients().slice(0, 20),
      steps: labels.map((label) =>
        stepStats(
          label,
          samples.filter((sample) => sample.label === label),
        ),
      ),
      samples: samples.slice(-2000),
      warnings: [...warnings].slice(0, 50),
    };
    update(current);
    return current;
  };
  try {
    for (let iteration = 0; iteration < plan.warmup + plan.iterations; iteration++) {
      const measured = iteration >= plan.warmup;
      for (const step of plan.setup) {
        deps.progress(iteration, `setup: ${step.label}`);
        await measureStep(deps, plan, step);
      }
      for (const step of plan.steps) {
        deps.progress(iteration, step.label);
        const outcome = await measureStep(deps, plan, step);
        if (outcome.timedOut) {
          const area = bounds(outcome.paints.filter((change) => change.t >= outcome.end - 2000));
          warnings.add(
            `"${step.label}" did not settle within ${step.timeoutMs ?? plan.timeoutMs} ms; its duration is the timeout.${area ? ` Repaints continued around x=${area.x}, y=${area.y}, width=${area.width}, height=${area.height}; exclude that area with region.` : ""} Or end the step with until and a mark/measure.`,
          );
        }
        if (outcome.paintIgnored)
          warnings.add(
            `"${step.label}": the window repainted across most of its area before input, so repaints could not show completion and first paint is unavailable; durations use add-in activity. Set region, such as the task pane, for paint timing.`,
          );
        else if (outcome.backgroundCoverage)
          warnings.add(
            `"${step.label}": repaints already occurring before input (about ${Math.round(outcome.backgroundCoverage * 100)}% of the window) were ignored.`,
          );
        if (!measured) continue;
        const sample = await sampleStep(deps, outcome, iteration - plan.warmup, step.label, plan);
        if (
          !sample.syncs &&
          !sample.requests &&
          !sample.firstPaint &&
          !step.until &&
          step.action !== "wait"
        )
          warnings.add(`"${step.label}" produced no observable repaint or add-in activity.`);
        samples.push(sample);
      }
      finish({
        progress: { iteration: iteration + 1, iterations: plan.warmup + plan.iterations, step: "" },
      });
    }
    return finish({ state: "completed", finishedAt: new Date().toISOString() });
  } catch (cause) {
    const cancelled = deps.cancelled();
    return finish({
      state: cancelled ? "cancelled" : "failed",
      finishedAt: new Date().toISOString(),
      error: cancelled ? null : cause instanceof Error ? cause.message : "The benchmark failed.",
    });
  }
}

export const listing = (report: BenchmarkReport): BenchmarkListing => ({
  id: report.id,
  name: report.name,
  state: report.state,
  createdAt: report.createdAt,
  iterations: report.iterations,
  steps: report.steps.map((step) => ({
    label: step.label,
    p50: step.duration.p50,
    p95: step.duration.p95,
  })),
  regressions: report.comparison?.steps.filter((step) => step.verdict === "regression").length ?? 0,
});

const isReport = Schema.is(BenchmarkReportSchema);
// Reports survive restarts for baseline comparison. Only Cinderdeck-generated files in
// its own state directory are read or pruned.
export class BenchmarkStore {
  private readonly reports = new Map<string, BenchmarkReport>();
  private loaded: Promise<void> | null = null;
  private readonly directory: string | null;
  constructor(directory: string | null) {
    this.directory = directory;
  }
  private load() {
    this.loaded ??= (async () => {
      if (!this.directory) return;
      const names = await NodeFSP.readdir(this.directory).catch(() => [] as string[]);
      for (const name of names.filter((entry) => /^bench-[a-z0-9-]+\.json$/.test(entry))) {
        try {
          const value: unknown = JSON.parse(
            await NodeFSP.readFile(NodePath.join(this.directory, name), "utf8"),
          );
          if (isReport(value) && !this.reports.has(value.id))
            this.reports.set(
              value.id,
              value.state === "running"
                ? {
                    ...value,
                    state: "failed",
                    error: "Cinderdeck restarted during this benchmark.",
                  }
                : value,
            );
        } catch {
          /* ignore an unreadable report */
        }
      }
    })();
    return this.loaded;
  }
  async get(id: string) {
    await this.load();
    return this.reports.get(id) ?? null;
  }
  async list() {
    await this.load();
    return [...this.reports.values()]
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100);
  }
  put(report: BenchmarkReport) {
    this.reports.set(report.id, report);
  }
  async save(report: BenchmarkReport) {
    await this.load();
    this.reports.set(report.id, report);
    const sorted = [...this.reports.values()].toSorted((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    for (const old of sorted.slice(100)) {
      this.reports.delete(old.id);
      if (this.directory)
        await NodeFSP.rm(NodePath.join(this.directory, `${old.id}.json`), { force: true });
    }
    if (!this.directory) return;
    await NodeFSP.mkdir(this.directory, { recursive: true });
    const path = NodePath.join(this.directory, `${report.id}.json`);
    await NodeFSP.writeFile(`${path}.tmp`, JSON.stringify(report));
    await NodeFSP.rename(`${path}.tmp`, path);
  }
}
