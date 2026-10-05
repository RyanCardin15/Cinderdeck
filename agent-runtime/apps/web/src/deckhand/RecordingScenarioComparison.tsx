import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import type {
  Evidence,
  VerificationOverview,
  VerificationScenario,
  VerificationScenarioSave,
} from "@t3tools/contracts/deckhand/verificationRpc";
import { useEffect, useRef, useState } from "react";
import * as Cause from "effect/Cause";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironmentHttpBaseUrl } from "../state/environments";
import { randomUUID } from "../lib/utils";
import { recordingMedia } from "./recordingState";
import { saveVerificationScenario, removeVerificationScenario } from "./verificationState";
import styles from "./recordingScenario.module.css";

function ComparisonRecording({
  environmentId,
  evidence,
  expectedHash,
  label,
  onOpen,
}: {
  environmentId: EnvironmentId;
  evidence: Evidence | undefined;
  expectedHash: string;
  label: string;
  onOpen: (item: Evidence) => void;
}) {
  const media = useAtomCommand(recordingMedia, { reportFailure: false });
  const base = useEnvironmentHttpBaseUrl(environmentId);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, refresh] = useState(0);
  const current = evidence?.manifestHash === expectedHash ? evidence : undefined;
  useEffect(() => {
    let active = true;
    setUrl(null);
    setError(null);
    if (!current || !base) return;
    void media({ environmentId, input: current.context })
      .then((result) => {
        if (!active) return;
        if (result._tag === "Failure") setError(Cause.pretty(result.cause));
        else setUrl(new URL(result.value.path, base).href);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, [media, environmentId, current, base, revision]);
  return (
    <article className={styles.recording}>
      <header>
        <strong>{label}</strong>
        {current ? <button onClick={() => onOpen(current)}>Open timeline and logs</button> : null}
      </header>
      {current ? (
        <>
          <h4>{current.recording.title}</h4>
          {url ? (
            <video
              key={url}
              controls
              preload="metadata"
              src={url}
              aria-label={`${label} recording`}
              onError={() =>
                setError("Media unavailable. Renew access or open the recording for recovery.")
              }
            />
          ) : (
            <p>{error ? "Recording media unavailable" : "Loading recording…"}</p>
          )}
          {error ? (
            <div role="alert">
              <p>{error}</p>
              <button onClick={() => refresh((value) => value + 1)}>Renew media access</button>
            </div>
          ) : null}
          <dl>
            <div>
              <dt>Captured</dt>
              <dd>{new Date(current.recording.createdAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Result</dt>
              <dd>
                {current.recording.checkOutcome} · {Math.round(current.recording.duration)}s
              </dd>
            </div>
            <div>
              <dt>Logs</dt>
              <dd>
                {current.recording.lineCount} lines · {current.recording.errorCount} errors
              </dd>
            </div>
            <div>
              <dt>Source against current PR</dt>
              <dd>{current.sourceState.replaceAll("_", " ")}</dd>
            </div>
            <div>
              <dt>Declared build</dt>
              <dd>
                {current.recording.buildProof
                  ? `Receipt ${current.recording.buildProof.receiptID} · start ${current.recording.buildProof.start.state} · end ${current.recording.buildProof.end?.state ?? "unknown"}`
                  : "Unknown"}
              </dd>
            </div>
          </dl>
          <p className={styles.note}>{current.reason}</p>
        </>
      ) : (
        <p>
          This recording is no longer attached or its saved manifest is unavailable. The comparison
          retains its original identity; reattach the same recording to inspect it.
        </p>
      )}
    </article>
  );
}

export function RecordingScenarioComparison({
  environmentId,
  reference,
  view,
  onChange,
  onOpen,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  view: VerificationOverview;
  onChange: (view: VerificationOverview) => void;
  onOpen: (item: Evidence) => void;
}) {
  const save = useAtomCommand(saveVerificationScenario, { reportFailure: false });
  const remove = useAtomCommand(removeVerificationScenario, { reportFailure: false });
  const [title, setTitle] = useState("");
  const [baseline, setBaseline] = useState("");
  const [followup, setFollowup] = useState("");
  const [selectedID, select] = useState("");
  const [pending, setPending] = useState<VerificationScenarioSave | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const executing = useRef(false);
  const scenarios = view.scenarios ?? [];
  const selected: VerificationScenario | undefined = scenarios.find(
    (item) => item.id === selectedID,
  );
  const candidates = view.evidence.filter(
    (item) => item.recording.playable && item.recording.state === "ready",
  );
  const mutate = async (action: "save" | "remove") => {
    if (executing.current || (action === "remove" && !selected)) return;
    executing.current = true;
    setBusy(true);
    setError(null);
    const input = pending ?? {
      reference,
      scenarioID: randomUUID(),
      title: title.trim(),
      featureID:
        candidates.find((item) => `${item.artifactID}:${item.featureID}` === baseline)?.featureID ??
        "",
      baselineArtifactID: baseline.split(":")[0] ?? "",
      followupArtifactID: followup.split(":")[0] ?? "",
    };
    if (action === "save") setPending(input);
    try {
      const result =
        action === "save"
          ? await save({ environmentId, input })
          : await remove({ environmentId, input: { reference, scenarioID: selected!.id } });
      if (result._tag === "Failure") throw new Error(Cause.pretty(result.cause));
      onChange(result.value);
      if (action === "save") {
        select(input.scenarioID);
        setPending(null);
      } else select("");
    } catch (cause) {
      setError(String(cause));
    } finally {
      executing.current = false;
      setBusy(false);
    }
  };
  return (
    <section className={styles.section}>
      <header>
        <div>
          <h3>Before and after</h3>
          <p>Compare two recordings of a named scenario.</p>
        </div>
      </header>
      <p className={styles.note}>
        Scenario continuity is your explicit association. Each capture keeps its own source and
        build evidence; the video target remains unverified.
      </p>
      {scenarios.length ? (
        <div className={styles.saved}>
          <label>
            Saved comparison
            <select
              value={selectedID}
              disabled={busy}
              onChange={(event) => select(event.target.value)}
            >
              <option value="">Choose comparison…</option>
              {scenarios.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>
          {selected ? (
            <button disabled={busy} onClick={() => void mutate("remove")}>
              Remove comparison
            </button>
          ) : null}
        </div>
      ) : null}
      {selected ? (
        <div className={styles.pair}>
          <ComparisonRecording
            key={`${selected.id}:before`}
            label="Before · baseline"
            environmentId={environmentId}
            evidence={view.evidence.find(
              (item) =>
                item.artifactID === selected.baselineArtifactID &&
                item.featureID === selected.featureID,
            )}
            expectedHash={selected.baselineManifestHash}
            onOpen={onOpen}
          />
          <ComparisonRecording
            key={`${selected.id}:after`}
            label="After · follow-up"
            environmentId={environmentId}
            evidence={view.evidence.find(
              (item) =>
                item.artifactID === selected.followupArtifactID &&
                item.featureID === selected.featureID,
            )}
            expectedHash={selected.followupManifestHash}
            onOpen={onOpen}
          />
        </div>
      ) : null}
      <details className={styles.create}>
        <summary>Create comparison</summary>
        <div className={styles.fields}>
          <label>
            Scenario
            <input
              maxLength={120}
              value={title}
              disabled={busy || !!pending}
              placeholder="Payment retry"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            Before
            <select
              value={baseline}
              disabled={busy || !!pending}
              onChange={(event) => {
                setBaseline(event.target.value);
                setFollowup("");
              }}
            >
              <option value="">Select baseline…</option>
              {candidates.map((item) => (
                <option
                  key={`${item.artifactID}:${item.featureID}:${item.checkoutID}`}
                  value={`${item.artifactID}:${item.featureID}`}
                >
                  {item.recording.title} · {item.recording.checkOutcome}
                </option>
              ))}
            </select>
          </label>
          <label>
            After
            <select
              value={followup}
              disabled={busy || !!pending}
              onChange={(event) => setFollowup(event.target.value)}
            >
              <option value="">Select follow-up…</option>
              {candidates
                .filter(
                  (item) =>
                    item.artifactID !== baseline.split(":")[0] &&
                    item.featureID ===
                      candidates.find(
                        (before) => `${before.artifactID}:${before.featureID}` === baseline,
                      )?.featureID,
                )
                .map((item) => (
                  <option
                    key={`${item.artifactID}:${item.featureID}:${item.checkoutID}`}
                    value={`${item.artifactID}:${item.featureID}`}
                  >
                    {item.recording.title} · {item.recording.checkOutcome}
                  </option>
                ))}
            </select>
          </label>
          <button
            disabled={busy || (!pending && (!title.trim() || !baseline || !followup))}
            onClick={() => void mutate("save")}
          >
            {busy ? "Saving…" : pending ? "Retry saved request" : "Save comparison"}
          </button>
          {pending && !busy ? (
            <button
              onClick={() => {
                setPending(null);
                setError(null);
              }}
            >
              Start a new comparison
            </button>
          ) : null}
        </div>
        {candidates.length < 2 ? (
          <p>Attach two completed playable recordings to compare them.</p>
        ) : null}
      </details>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
