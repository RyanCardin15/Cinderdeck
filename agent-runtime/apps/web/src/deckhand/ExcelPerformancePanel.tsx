import { useEffect, useState } from "react";
import { ActivityIcon, ChevronDownIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import type { EnvironmentId, ThreadId } from "@cinderdeck/contracts";
import {
  excelProbeSnippets,
  type BenchmarkListing,
  type BenchmarkReport,
  type Distribution,
  type ProbeStatus,
} from "@cinderdeck/contracts/deckhand/excelPerformance";
import { squashAtomCommandFailure } from "@cinderdeck/client-runtime/state/runtime";
import { Button } from "../components/ui/button";
import { useAtomCommand } from "../state/use-atom-command";
import { excelBenchmark, excelProbe } from "./externalDebugState";
import styles from "./externalAppPanel.module.css";

const ms = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
const bytes = (value: number) =>
  value >= 1_048_576
    ? `${(value / 1_048_576).toFixed(1)} MB`
    : value >= 1024
      ? `${Math.round(value / 1024)} KB`
      : `${value} B`;
const spread = (value: Distribution) =>
  value.count ? `${ms(value.p50)} · p95 ${ms(value.p95)}` : "—";
const failureText = (value: unknown) =>
  typeof value === "object" && value !== null && "message" in value
    ? String(value.message)
    : "Couldn’t reach the add-in probe.";

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

function Report({ report }: { report: BenchmarkReport }) {
  return (
    <div className={styles.report}>
      {report.state === "running" ? (
        <p>
          Iteration {report.progress.iteration + 1} of {report.progress.iterations}
          {report.progress.step ? ` · ${report.progress.step}` : ""}
        </p>
      ) : null}
      {report.error ? <p className={styles.reportWarning}>{report.error}</p> : null}
      {report.steps.length ? (
        <table>
          <thead>
            <tr>
              <th>Step</th>
              <th>Duration</th>
              <th>First paint</th>
              <th>Office syncs</th>
              <th>Requests</th>
              <th>CPU</th>
            </tr>
          </thead>
          <tbody>
            {report.steps.map((step) => {
              const change = report.comparison?.steps.find((entry) => entry.label === step.label);
              return (
                <tr key={step.label}>
                  <td>{step.label}</td>
                  <td data-verdict={change?.verdict}>
                    {spread(step.duration)}
                    {change && change.verdict !== "unchanged"
                      ? ` (${change.deltaP50Percent > 0 ? "+" : ""}${change.deltaP50Percent}%)`
                      : ""}
                  </td>
                  <td>{step.firstPaint ? ms(step.firstPaint.p50) : "—"}</td>
                  <td>
                    {step.syncs.p50} · {ms(step.syncTime.p50)}
                  </td>
                  <td>
                    {step.requests.p50} · {bytes(step.transferBytes.p50)}
                  </td>
                  <td>{step.cpuAverage ? `${Math.round(step.cpuAverage.p50)}%` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      {report.warnings.map((warning) => (
        <p key={warning} className={styles.reportWarning}>
          {warning}
        </p>
      ))}
    </div>
  );
}

// Add-in telemetry and saved benchmarks for the thread's Excel attachment. The agent
// drives benchmarks with deckhand_excel_benchmark; this section shows their results.
export function ExcelPerformancePanel({
  environmentId,
  threadId,
  visible,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  visible: boolean;
}) {
  const probe = useAtomCommand(excelProbe, { reportFailure: false });
  const benchmark = useAtomCommand(excelBenchmark, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ProbeStatus | null>(null);
  const [reports, setReports] = useState<readonly BenchmarkListing[]>([]);
  const [selected, setSelected] = useState<BenchmarkReport | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const selectedId = selected?.id;
  const selectedRunning = selected?.state === "running";
  useEffect(() => {
    if (!open || !visible) return;
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
  }, [open, visible, environmentId, threadId, probe, benchmark, selectedId, selectedRunning]);
  async function toggleCollecting() {
    if (!status || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await probe({
        environmentId,
        input: { action: status.armed ? "disarm" : "arm", waitForClientMs: 0, threadId },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setStatus(result.value.status);
    } catch (cause) {
      setError(failureText(cause));
    } finally {
      setBusy(false);
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
  const connected = status?.clients.filter((client) => client.connected) ?? [];
  const summary = status?.summary;
  const snippets = excelProbeSnippets("webpack", status?.port);
  return (
    <section className={styles.performance}>
      <button className={styles.performanceHeader} onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
        <ActivityIcon size={14} />
        <span>Add-in performance</span>
        {status ? (
          <span className={styles.probeState} data-connected={connected.length > 0}>
            {connected.length
              ? `${connected.length} page${connected.length > 1 ? "s" : ""}${status.armed ? " · collecting" : ""}`
              : "Probe not connected"}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className={styles.performanceBody}>
          {error || status?.unavailable ? (
            <p className={styles.reportWarning}>{error || status?.unavailable}</p>
          ) : null}
          {connected.map((client) => (
            <p key={client.id} className={styles.probeClient}>
              {client.title || client.page} {client.office ? `· ${client.office}` : ""}
            </p>
          ))}
          {status?.armed && summary ? (
            <dl className={styles.metrics}>
              <div>
                <dt>Excel.run</dt>
                <dd>{spread(summary.runs)}</dd>
              </div>
              <div>
                <dt>context.sync</dt>
                <dd>
                  {summary.syncs.count} · {spread(summary.syncs)}
                </dd>
              </div>
              <div>
                <dt>Requests</dt>
                <dd>
                  {summary.requests.count}
                  {summary.requestFailures ? ` · ${summary.requestFailures} failed` : ""}
                </dd>
              </div>
              <div>
                <dt>Downloaded</dt>
                <dd>{bytes(summary.transferBytes)}</dd>
              </div>
              <div>
                <dt>Errors</dt>
                <dd>{summary.errors}</dd>
              </div>
              <div>
                <dt>Longest stall</dt>
                <dd>{summary.jank.count ? ms(summary.jank.max) : "—"}</dd>
              </div>
            </dl>
          ) : null}
          <div className={styles.performanceActions}>
            <Button
              size="sm"
              variant="outline"
              disabled={!status || busy}
              onClick={() => void toggleCollecting()}
            >
              {status?.armed ? "Stop collecting" : "Collect add-in telemetry"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowSetup((value) => !value)}>
              {showSetup ? "Hide setup" : "Set up probe"}
            </Button>
          </div>
          {showSetup ? (
            <div className={styles.probeSetup}>
              <p>
                Add these development-only lines to the add-in (webpack shown), restart its dev
                server and reload the task pane. Or ask the agent to “set up the Cinderdeck Excel
                probe”; it detects webpack or Vite and edits the project for review.
              </p>
              <Snippet label="Dev-server proxy" code={snippets.proxySnippet} />
              <Snippet label="Task pane entry (first statement)" code={snippets.loaderSnippet} />
            </div>
          ) : null}
          <h3 className={styles.performanceHeading}>Benchmarks</h3>
          {reports.length ? (
            <ul className={styles.reports}>
              {reports.slice(0, 10).map((entry) => (
                <li key={entry.id}>
                  <button
                    onClick={() => void view(entry.id)}
                    aria-expanded={selected?.id === entry.id}
                  >
                    <span>{entry.name}</span>
                    <span>
                      {entry.state === "completed"
                        ? entry.steps
                            .slice(0, 2)
                            .map((step) => `${step.label} ${ms(step.p50)}`)
                            .join(" · ")
                        : entry.state}
                      {entry.regressions ? ` · ${entry.regressions} regressed` : ""}
                    </span>
                  </button>
                  {selected?.id === entry.id ? <Report report={selected} /> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.probeClient}>
              Ask the agent to benchmark an interaction, for example “benchmark the Validate button
              five times”.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
