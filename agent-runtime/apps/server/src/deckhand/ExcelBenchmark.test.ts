// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type {
  BenchmarkReport,
  BenchmarkStep,
  ProbeEvent,
} from "@cinderdeck/contracts/deckhand/excelPerformance";
import {
  BenchmarkStore,
  compareReports,
  runBenchmark,
  significantChanges,
  type BenchmarkDeps,
  type BenchmarkPlan,
  type ProcessSample,
  type RepaintChange,
} from "./ExcelBenchmark.ts";
import { distribution } from "./ExcelProbe.ts";

// A simulated Mac: each input schedules repaints and add-in events relative to dispatch.
function simulated(
  respond: (
    step: BenchmarkStep,
    at: number,
    index: number,
  ) => {
    paints?: RepaintChange[];
    events?: Omit<ProbeEvent, "sequence" | "client">[];
    pendingUntil?: number;
  },
  // Repaints that happen regardless of input, e.g. Excel redrawing while idle.
  background?: (t: number) => RepaintChange | null,
) {
  let clock = 1_700_000_000_000;
  let index = 0;
  let pendingUntil = 0;
  const changes: RepaintChange[] = [];
  const events: ProbeEvent[] = [];
  const samples: ProcessSample[] = [];
  const deps: BenchmarkDeps = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      samples.push({ t: clock, cpu: 40, memory: 200_000_000 + (clock % 1000), processes: 3 });
    },
    act: async (step) => {
      const at = clock;
      const result = respond(step, at, index++);
      changes.push(...(result.paints ?? []));
      for (const event of result.events ?? [])
        events.push({ ...event, client: "page", sequence: events.length + 1 });
      pendingUntil = result.pendingUntil ?? 0;
      return at;
    },
    timeline: async (since) => ({
      changes: [
        ...changes,
        ...Array.from({ length: Math.max(0, Math.floor((clock - since) / 50)) }, (_, i) =>
          background?.(Math.floor(since / 50) * 50 + (i + 1) * 50),
        ).filter((change): change is RepaintChange => Boolean(change)),
      ]
        .filter((change) => change.t > since && change.t <= clock)
        .toSorted((a, b) => a.t - b.t),
      samples: samples.filter((sample) => sample.t > since),
    }),
    probeEvents: (from, to) =>
      events.filter((event) => event.start >= from && event.start <= Math.min(to, clock)),
    probeActivity: () => ({
      clients: 1,
      pending: clock < pendingUntil ? 1 : 0,
      deliveredThrough: clock - 50,
    }),
    probeClients: () => [],
    cancelled: () => false,
    progress: () => undefined,
  };
  return deps;
}
const plan = (overrides: Partial<BenchmarkPlan> = {}): BenchmarkPlan => ({
  iterations: 3,
  warmup: 1,
  setup: [],
  steps: [{ label: "Validate sheet", action: "press", ref: "e4" }],
  region: null,
  settleMs: 300,
  timeoutMs: 5000,
  paint: true,
  ...overrides,
});
const report = (overrides: Partial<BenchmarkReport> = {}): BenchmarkReport => ({
  id: "bench-test",
  name: "Validation",
  state: "running",
  createdAt: "2026-10-05T12:00:00.000Z",
  finishedAt: null,
  progress: { iteration: 0, iterations: 4, step: "" },
  target: { app: "Microsoft Excel", title: "Book1" },
  clients: [],
  iterations: 3,
  warmup: 1,
  region: null,
  paintMeasured: true,
  processesMeasured: 3,
  steps: [],
  samples: [],
  warnings: [],
  error: null,
  comparison: null,
  ...overrides,
});

describe("Excel interaction benchmarks", () => {
  it("ends each step when repaints, Office round trips and requests settle", async () => {
    const deps = simulated((_step, at) => ({
      paints: [
        { t: at + 40, area: 0.2, rects: [[0.7, 0, 0.3, 1]] },
        // A caret-sized repaint must not extend the step.
        { t: at + 900, area: 0.0001, rects: [[0.1, 0.1, 0.001, 0.02]] },
      ],
      events: [
        { kind: "run", start: at + 5, end: at + 410, count: 2, ok: true },
        { kind: "sync", start: at + 10, end: at + 120, ok: true, count: 14 },
        {
          kind: "fetch",
          start: at + 130,
          end: at + 330,
          ok: true,
          status: 200,
          name: "https://api.test/validate",
        },
        { kind: "sync", start: at + 340, end: at + 400, ok: true },
        {
          kind: "resource",
          start: at + 130,
          end: at + 335,
          bytes: 5120,
          name: "https://api.test/validate",
        },
        { kind: "measure", start: at + 2, end: at + 405, name: "validate" },
      ],
      pendingUntil: at + 400,
    }));
    const result = await runBenchmark(deps, plan(), report(), () => undefined);
    expect(result.state).toBe("completed");
    expect(result.samples).toHaveLength(3);
    const [step] = result.steps;
    expect(step).toMatchObject({ label: "Validate sheet", samples: 3, timedOut: 0 });
    expect(step!.duration.p50).toBe(410);
    expect(step!.firstPaint?.p50).toBe(40);
    expect(step!.syncs.p50).toBe(2);
    expect(step!.syncTime.p50).toBe(170);
    expect(step!.requests.p50).toBe(1);
    expect(step!.transferBytes.p50).toBe(5120);
    expect(step!.measures).toEqual([expect.objectContaining({ name: "validate", p50: 403 })]);
    expect(step!.cpuAverage?.p50).toBe(40);
    expect(result.warnings).toEqual([]);
  });

  it("can end at a named measure, excludes warm-up and setup, and reports timeouts", async () => {
    const deps = simulated((step, at, index) =>
      step.label === "Load data"
        ? {
            events: [{ kind: "measure", start: at + 1, end: at + 250 + index, name: "load" }],
            // Background polling keeps requests outstanding; the measure still ends the step.
            pendingUntil: at + 60_000,
          }
        : step.label === "Spinner"
          ? {
              paints: Array.from({ length: 30 }, (_, i) => ({
                t: at + i * 50,
                area: 0.3,
                rects: [[0, 0, 1, 1]],
              })),
            }
          : {},
    );
    const result = await runBenchmark(
      deps,
      plan({
        iterations: 2,
        warmup: 1,
        setup: [{ label: "Select A1", action: "key", key: "Home", modifiers: ["control"] }],
        steps: [
          { label: "Load data", action: "click", x: 0.8, y: 0.3, until: { measure: "load" } },
          { label: "Spinner", action: "click", x: 0.5, y: 0.5, timeoutMs: 1000 },
        ],
      }),
      report(),
      () => undefined,
    );
    const load = result.samples.filter((sample) => sample.label === "Load data");
    expect(load.map((sample) => sample.duration)).toEqual([254, 257]);
    expect(result.samples.some((sample) => sample.label === "Select A1")).toBe(false);
    expect(result.steps.find((step) => step.label === "Spinner")?.timedOut).toBe(2);
    expect(result.warnings.join(" ")).toContain('"Spinner" did not settle within 1000 ms');
  });

  it("ignores repaints that were already happening before the input", async () => {
    const respond = (_step: BenchmarkStep, at: number) => ({
      paints: [{ t: at + 60, area: 0.1, rects: [[0.7, 0.1, 0.25, 0.3]] }],
      events: [{ kind: "sync" as const, start: at + 5, end: at + 180, ok: true }],
    });
    // A status area that redraws every 50 ms forever, as real Excel did while idle.
    const status = (t: number) => ({ t, area: 0.01, rects: [[0.02, 0.96, 0.3, 0.03]] });
    const settled = await runBenchmark(
      simulated(respond, status),
      plan({ iterations: 2 }),
      report(),
      () => undefined,
    );
    expect(settled.steps[0]).toMatchObject({ timedOut: 0 });
    expect(settled.steps[0]!.duration.p50).toBe(180);
    expect(settled.steps[0]!.firstPaint?.p50).toBe(60);
    expect(settled.warnings.join(" ")).toContain("were ignored");
    // Without dirty rectangles every frame covers the whole window: fall back to
    // add-in activity instead of timing out, and do not report a misleading first paint.
    const whole = await runBenchmark(
      simulated(respond, (t) => ({ t, area: 1, rects: [[0, 0, 1, 1]] })),
      plan({ iterations: 2 }),
      report(),
      () => undefined,
    );
    expect(whole.steps[0]).toMatchObject({ timedOut: 0, firstPaint: null });
    expect(whole.steps[0]!.duration.p50).toBe(180);
    expect(whole.warnings.join(" ")).toContain("repainted across most of its area");
  });

  it("names where repaints continued when a step times out", async () => {
    const result = await runBenchmark(
      simulated((_step, at) => ({
        paints: Array.from({ length: 80 }, (_, i) => ({
          t: at + i * 50,
          area: 0.02,
          rects: [[0.5, 0.5, 0.1, 0.1]],
        })),
      })),
      plan({ iterations: 1, warmup: 0, timeoutMs: 1000 }),
      report(),
      () => undefined,
    );
    expect(result.warnings.join(" ")).toContain(
      "Repaints continued around x=0.5, y=0.5, width=0.1, height=0.1",
    );
  });

  it("filters repaints to a region and flags regressions only beyond noise", () => {
    const changes = [
      { t: 1, area: 0.05, rects: [[0, 0, 0.2, 0.2]] },
      { t: 2, area: 0.05, rects: [[0.75, 0.2, 0.2, 0.2]] },
    ];
    expect(significantChanges(changes, { x: 0.7, y: 0, width: 0.3, height: 1 })).toEqual([
      changes[1],
    ]);
    const stats = (p50: number) => ({
      label: "Validate",
      samples: 5,
      timedOut: 0,
      duration: { ...distribution([p50]), p95: p50 * 1.2 },
      firstPaint: null,
      syncs: distribution([1]),
      syncTime: distribution([1]),
      requests: distribution([0]),
      requestTime: distribution([0]),
      transferBytes: distribution([0]),
      errors: 0,
      jankMax: distribution([0]),
      cpuAverage: null,
      memoryPeak: null,
      measures: [],
    });
    const baseline = report({ id: "bench-base", state: "completed", steps: [stats(400)] });
    expect(compareReports([stats(500)], baseline).steps[0]).toMatchObject({
      verdict: "regression",
      deltaP50Percent: 25,
    });
    expect(compareReports([stats(415)], baseline).steps[0]?.verdict).toBe("unchanged");
    expect(compareReports([stats(300)], baseline).steps[0]?.verdict).toBe("improvement");
    expect(distribution([5, 1, 3, 2, 4])).toMatchObject({
      min: 1,
      p50: 3,
      p95: 5,
      max: 5,
      mean: 3,
    });
  });

  it("persists reports for later baselines and marks interrupted runs failed", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "excel-bench-"));
    try {
      const store = new BenchmarkStore(directory);
      await store.save(report({ id: "bench-a", state: "completed" }));
      await store.save(report({ id: "bench-b", createdAt: "2026-10-05T13:00:00.000Z" }));
      await NodeFSP.writeFile(NodePath.join(directory, "bench-bad.json"), "{");
      const reopened = new BenchmarkStore(directory);
      expect((await reopened.list()).map((entry) => entry.id)).toEqual(["bench-b", "bench-a"]);
      expect(await reopened.get("bench-b")).toMatchObject({ state: "failed" });
      expect(await reopened.get("bench-a")).toMatchObject({ state: "completed" });
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
