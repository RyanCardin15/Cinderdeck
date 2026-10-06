import { useEffect, useState } from "react";
import {
  ActivityIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  MessageSquarePlusIcon,
  PlugIcon,
  RotateCcwIcon,
} from "lucide-react";
import type { ScopedThreadRef } from "@cinderdeck/contracts";
import {
  excelProbeSnippets,
  type BenchmarkListing,
  type BenchmarkReport,
  type Distribution,
  type ProbeSetup,
  type ProbeStatus,
} from "@cinderdeck/contracts/deckhand/excelPerformance";
import { squashAtomCommandFailure } from "@cinderdeck/client-runtime/state/runtime";
import { Button } from "../components/ui/button";
import { useComposerDraftStore } from "../composerDraftStore";
import { useAtomCommand } from "../state/use-atom-command";
import { excelBenchmark, excelProbe } from "./externalDebugState";
import styles from "./excelPerformance.module.css";

const ms = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
const bytes = (value: number) =>
  value >= 1_048_576
    ? `${(value / 1_048_576).toFixed(1)} MB`
    : value >= 1024
      ? `${Math.round(value / 1024)} KB`
      : `${value} B`;
const p50 = (value: Distribution | null | undefined) => (value?.count ? ms(value.p50) : "—");
const p95 = (value: Distribution | null | undefined) => (value?.count ? ms(value.p95) : "—");
const when = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
};
const failureText = (value: unknown) =>
  typeof value === "object" && value !== null && "message" in value
    ? String(value.message)
    : "Couldn’t reach the add-in probe.";
// How long Connect probe waits for the task pane to report in; pages poll every 1–10 s.
const CONNECT_WAIT_MS = 12_000;
export const PROBE_SETUP_PROMPT =
  "Set up the Cinderdeck Excel performance probe in this add-in project: run deckhand_excel_probe setup for the project root, apply the dev-server proxy and loader edits it returns, then tell me to restart the dev server and reload the task pane.";

function Snippet({ label, code }: { label: string; code: string }) {
  return (
    <div className={styles.snippet}>
      <div>
        <span>{label}</span>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Copy ${label}`}
          onClick={() => void navigator.clipboard?.writeText(code)}
        >
          <CopyIcon />
        </Button>
      </div>
      <pre>{code}</pre>
    </div>
  );
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string | undefined;
}) {
  return (
    <div className={styles.stat}>
      <dt>{label}</dt>
      <dd>
        <strong>{value}</strong>
        {detail ? <span>{detail}</span> : null}
      </dd>
    </div>
  );
}

function Report({ report }: { report: BenchmarkReport }) {
  const measures = report.steps.flatMap((step) =>
    step.measures.map((measure) => ({ step: step.label, ...measure })),
  );
  return (
    <div className={styles.report}>
      <p className={styles.reportMeta}>
        {[
          report.target.title || report.target.app,
          `${report.iterations} iteration${report.iterations === 1 ? "" : "s"}`,
          report.warmup ? `${report.warmup} warm-up` : null,
          report.comparison ? `vs ${report.comparison.baselineName}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {report.state === "running" ? (
        <p className={styles.progress}>
          Iteration {report.progress.iteration + 1} of {report.progress.iterations}
          {report.progress.step ? ` · ${report.progress.step}` : ""}
        </p>
      ) : null}
      {report.error ? <p className={styles.warning}>{report.error}</p> : null}
      {report.steps.length ? (
        <div className={styles.tableScroll}>
          <table>
            <thead>
              <tr>
                <th>Step</th>
                <th>p50</th>
                <th>p95</th>
                {report.comparison ? <th>Change</th> : null}
                <th>First paint</th>
                <th>Office syncs</th>
                <th>Requests</th>
                <th>Longest stall</th>
                <th>CPU</th>
                <th>Memory</th>
              </tr>
            </thead>
            <tbody>
              {report.steps.map((step) => {
                const change = report.comparison?.steps.find((entry) => entry.label === step.label);
                return (
                  <tr key={step.label}>
                    <th scope="row">
                      {step.label}
                      {step.timedOut ? (
                        <span className={styles.timedOut}>{step.timedOut} timed out</span>
                      ) : null}
                    </th>
                    <td>{p50(step.duration)}</td>
                    <td>{p95(step.duration)}</td>
                    {report.comparison ? (
                      <td data-verdict={change?.verdict}>
                        {change
                          ? `${change.deltaP50Percent > 0 ? "+" : ""}${change.deltaP50Percent}%`
                          : "—"}
                      </td>
                    ) : null}
                    <td>{p50(step.firstPaint)}</td>
                    <td>
                      {step.syncs.p50} · {ms(step.syncTime.p50)}
                    </td>
                    <td>
                      {step.requests.p50} · {bytes(step.transferBytes.p50)}
                    </td>
                    <td>{p50(step.jankMax)}</td>
                    <td>{step.cpuAverage ? `${Math.round(step.cpuAverage.p50)}%` : "—"}</td>
                    <td>{step.memoryPeak ? bytes(step.memoryPeak.p50) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {measures.length ? (
        <div className={styles.tableScroll}>
          <table>
            <thead>
              <tr>
                <th>Measure</th>
                <th>Step</th>
                <th>p50</th>
                <th>p95</th>
              </tr>
            </thead>
            <tbody>
              {measures.map((measure) => (
                <tr key={`${measure.step}:${measure.name}`}>
                  <th scope="row">{measure.name}</th>
                  <td>{measure.step}</td>
                  <td>{p50(measure)}</td>
                  <td>{p95(measure)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {report.warnings.map((warning) => (
        <p key={warning} className={styles.warning}>
          {warning}
        </p>
      ))}
    </div>
  );
}

// Add-in telemetry and saved benchmarks for the thread's Excel attachment. The agent
// drives benchmarks with deckhand_excel_benchmark; this view shows their results.
export function ExcelPerformancePanel({
  threadRef,
  visible,
}: {
  threadRef: ScopedThreadRef;
  visible: boolean;
}) {
  const { environmentId, threadId } = threadRef;
  const probe = useAtomCommand(excelProbe, { reportFailure: false });
  const benchmark = useAtomCommand(excelBenchmark, { reportFailure: false });
  const [status, setStatus] = useState<ProbeStatus | null>(null);
  const [reports, setReports] = useState<readonly BenchmarkListing[]>([]);
  const [selected, setSelected] = useState<BenchmarkReport | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [bundler, setBundler] = useState<ProbeSetup["bundler"]>("webpack");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "connect" | "stop" | "reset">("");
  const selectedId = selected?.id;
  const selectedRunning = selected?.state === "running";
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    const refresh = async () => {
      const [probeResult, listResult] = await Promise.all([
        probe({ environmentId, input: { action: "status", threadId } }),
        benchmark({ environmentId, input: { action: "list", threadId } }),
      ]);
      if (disposed) return;
      if (probeResult._tag === "Success") setStatus(probeResult.value.status);
      if (listResult._tag === "Success") setReports(listResult.value.reports);
      if (selectedId && selectedRunning) {
        const result = await benchmark({
          environmentId,
          input: { action: "get", runId: selectedId, threadId },
        });
        if (!disposed && result._tag === "Success") setSelected(result.value.report);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [visible, environmentId, threadId, probe, benchmark, selectedId, selectedRunning]);
  async function run(action: "arm" | "disarm" | "reset") {
    if (busy) return;
    setBusy(action === "arm" ? "connect" : action === "disarm" ? "stop" : "reset");
    setError("");
    setNotice("");
    try {
      const alreadyConnected = status?.clients.some((client) => client.connected) ?? false;
      const result = await probe({
        environmentId,
        input: {
          action,
          // Arming waits for the task pane to report in unless it already has.
          waitForClientMs: action === "arm" && !alreadyConnected ? CONNECT_WAIT_MS : 0,
          threadId,
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setStatus(result.value.status);
      if (action === "arm" && !result.value.status.clients.some((client) => client.connected)) {
        setNotice(
          "Collecting, but no add-in page has reported in yet. If the probe hook isn’t installed, set it up below, restart the add-in’s dev server and reload the task pane.",
        );
        setShowSetup(true);
      }
    } catch (cause) {
      setError(failureText(cause));
    } finally {
      setBusy("");
    }
  }
  async function view(id: string) {
    if (selected?.id === id) return setSelected(null);
    const result = await benchmark({
      environmentId,
      input: { action: "get", runId: id, threadId },
    });
    if (result._tag === "Success") setSelected(result.value.report);
    else setError(failureText(squashAtomCommandFailure(result)));
  }
  function askAgent() {
    const store = useComposerDraftStore.getState();
    const draft = store.getComposerDraft(threadRef)?.prompt.trim();
    if (!draft?.includes(PROBE_SETUP_PROMPT))
      store.setPrompt(threadRef, draft ? `${draft}\n\n${PROBE_SETUP_PROMPT}` : PROBE_SETUP_PROMPT);
    setNotice("Added a setup request to the message box. Review it and send.");
  }
  const connected = status?.clients.filter((client) => client.connected) ?? [];
  const summary = status?.summary;
  const snippets = excelProbeSnippets(bundler, status?.port);
  const state = !status
    ? "loading"
    : connected.length
      ? status.armed
        ? "collecting"
        : "connected"
      : status.armed
        ? "waiting"
        : "off";
  return (
    <div className={styles.performance} role="tabpanel" aria-label="Add-in performance">
      <section className={styles.probeCard} data-state={state}>
        <div className={styles.probeHeader}>
          <span className={styles.probeDot} aria-hidden />
          <div className={styles.probeIdentity}>
            <strong>
              {state === "collecting"
                ? "Probe connected · collecting"
                : state === "connected"
                  ? "Probe connected"
                  : state === "waiting"
                    ? "Waiting for the add-in…"
                    : state === "loading"
                      ? "Checking probe…"
                      : "Probe not connected"}
            </strong>
            <span>
              {connected.length
                ? connected
                    .map(
                      (client) =>
                        `${client.title || client.page}${client.office ? ` · ${client.office}` : ""}`,
                    )
                    .join(", ")
                : "Times Excel.run, context.sync, network and stalls inside the add-in."}
            </span>
          </div>
          <div className={styles.probeActions}>
            {status?.armed ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={Boolean(busy)}
                  aria-label="Reset telemetry"
                  onClick={() => void run("reset")}
                >
                  <RotateCcwIcon />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={Boolean(busy)}
                  onClick={() => void run("disarm")}
                >
                  {busy === "stop" ? "Stopping…" : "Stop collecting"}
                </Button>
              </>
            ) : (
              <Button size="sm" disabled={!status || Boolean(busy)} onClick={() => void run("arm")}>
                <PlugIcon />
                {busy === "connect"
                  ? "Connecting…"
                  : connected.length
                    ? "Start collecting"
                    : "Connect probe"}
              </Button>
            )}
          </div>
        </div>
        {error || status?.unavailable ? (
          <p role="alert" className={styles.error}>
            {error || status?.unavailable}
          </p>
        ) : null}
        {notice ? <p className={styles.notice}>{notice}</p> : null}
        <button
          className={styles.disclosure}
          aria-expanded={showSetup}
          onClick={() => setShowSetup((value) => !value)}
        >
          {showSetup ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}
          Probe setup
        </button>
        {showSetup ? (
          <div className={styles.probeSetup}>
            <p>
              The probe needs two development-only lines in the add-in project. The agent can add
              them for you, or copy them yourself, restart the dev server and reload the task pane.
            </p>
            <div className={styles.setupActions}>
              <Button size="sm" variant="outline" onClick={askAgent}>
                <MessageSquarePlusIcon /> Ask agent to set it up
              </Button>
              <div className={styles.segmented} role="radiogroup" aria-label="Dev server">
                {(["webpack", "vite"] as const).map((entry) => (
                  <button
                    key={entry}
                    role="radio"
                    aria-checked={bundler === entry}
                    onClick={() => setBundler(entry)}
                  >
                    {entry === "vite" ? "Vite" : "webpack"}
                  </button>
                ))}
              </div>
            </div>
            <Snippet label="Dev-server proxy" code={snippets.proxySnippet} />
            <Snippet label="Task pane entry (first statement)" code={snippets.loaderSnippet} />
          </div>
        ) : null}
      </section>
      {status?.armed && summary ? (
        <section className={styles.section}>
          <h3>Live telemetry</h3>
          <dl className={styles.stats}>
            <Stat label="Excel.run" value={p50(summary.runs)} detail={`p95 ${p95(summary.runs)}`} />
            <Stat
              label="context.sync"
              value={String(summary.syncs.count)}
              detail={`${p50(summary.syncs)} p50${summary.syncFailures ? ` · ${summary.syncFailures} failed` : ""}`}
            />
            <Stat
              label="Requests"
              value={String(summary.requests.count)}
              detail={
                summary.requestFailures
                  ? `${summary.requestFailures} failed`
                  : summary.requests.count
                    ? `${p50(summary.requests)} p50`
                    : undefined
              }
            />
            <Stat
              label="Downloaded"
              value={bytes(summary.transferBytes)}
              detail={summary.resources.count ? `${summary.resources.count} resources` : undefined}
            />
            <Stat
              label="Errors"
              value={String(summary.errors)}
              detail={summary.warnings ? `${summary.warnings} warnings` : undefined}
            />
            <Stat
              label="Longest stall"
              value={summary.jank.count ? ms(summary.jank.max) : "—"}
              detail={summary.jank.count ? `${summary.jank.count} stalls` : undefined}
            />
          </dl>
          {summary.measures.length ? (
            <div className={styles.tableScroll}>
              <table>
                <thead>
                  <tr>
                    <th>Measure</th>
                    <th>Count</th>
                    <th>p50</th>
                    <th>p95</th>
                    <th>Max</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.measures.map((measure) => (
                    <tr key={measure.name}>
                      <th scope="row">{measure.name}</th>
                      <td>{measure.count}</td>
                      <td>{p50(measure)}</td>
                      <td>{p95(measure)}</td>
                      <td>{ms(measure.max)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}
      <section className={styles.section}>
        <h3>
          <ActivityIcon size={13} aria-hidden /> Benchmarks
          {reports.length ? <span className={styles.count}>{reports.length}</span> : null}
        </h3>
        {reports.length ? (
          <ul className={styles.reports}>
            {reports.slice(0, 20).map((entry) => (
              <li key={entry.id} data-open={selected?.id === entry.id}>
                <button
                  className={styles.reportRow}
                  onClick={() => void view(entry.id)}
                  aria-expanded={selected?.id === entry.id}
                >
                  {selected?.id === entry.id ? (
                    <ChevronDownIcon size={13} aria-hidden />
                  ) : (
                    <ChevronRightIcon size={13} aria-hidden />
                  )}
                  <span className={styles.reportName}>
                    <strong>{entry.name}</strong>
                    <span>
                      {[when(entry.createdAt), entry.iterations ? `${entry.iterations}×` : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className={styles.reportSummary}>
                    {entry.state === "completed"
                      ? entry.steps
                          .slice(0, 2)
                          .map((step) => `${step.label} ${ms(step.p50)}`)
                          .join(" · ")
                      : null}
                  </span>
                  {entry.state !== "completed" ? (
                    <span className={styles.badge} data-tone={entry.state}>
                      {entry.state}
                    </span>
                  ) : entry.regressions ? (
                    <span className={styles.badge} data-tone="regression">
                      {entry.regressions} regressed
                    </span>
                  ) : null}
                </button>
                {selected?.id === entry.id ? <Report report={selected} /> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.empty}>
            Ask the agent to benchmark an interaction, for example “benchmark the Validate button
            five times”. Results appear here.
          </p>
        )}
      </section>
    </div>
  );
}
