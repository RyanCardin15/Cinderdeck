import type { EnvironmentId, PullRequestRef, PullRequestDetail } from "@cinderdeck/contracts";
import type {
  RecordingContext,
  EvidencePreparation,
  EvidenceAsset,
} from "@cinderdeck/contracts/deckhand/recordingsRpc";
import { useEnvironmentHttpBaseUrl } from "../state/environments";
import { randomUUID } from "../lib/utils";
import { prepareEvidence, getEvidence, evidenceResource } from "./recordingState";
import { downloadEvidenceAssets, type EvidenceAssetTransfer } from "./evidenceTransfer";
import type { VerificationOverview, Evidence } from "@cinderdeck/contracts/deckhand/verificationRpc";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  CheckIcon,
  GitCommitHorizontalIcon,
  RefreshCwIcon,
  ShieldQuestionIcon,
  UnlinkIcon,
  VideoIcon,
  ArrowUpRightIcon,
} from "lucide-react";
import * as Cause from "effect/Cause";
import { buildThreadRouteParams } from "../threadRoutes";
import { useAtomCommand } from "../state/use-atom-command";
import { listVerification, linkVerification, unlinkVerification } from "./verificationState";
import { Recordings } from "./Recordings";
import styles from "./verification.module.css";
import { RecordingScenarioComparison } from "./RecordingScenarioComparison";
import { VerificationAttemptPanel } from "./VerificationAttemptPanel";
const labels: Record<Evidence["sourceState"], string> = {
  source_match: "Source matches PR head",
  stale: "Earlier PR revision",
  dirty: "Uncommitted source",
  unknown: "Source provenance unknown",
  unrelated: "Different repository",
};
export function PullRequestVerification({
  environmentId,
  reference,
  detail,
  onPrepareDraft,
  preparingDraft,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  detail: PullRequestDetail;
  onPrepareDraft: (
    prompt: string,
    files?: ReadonlyArray<File>,
  ) => Promise<{ accepted: number; total: number } | null>;
  preparingDraft: boolean;
}) {
  const list = useAtomCommand(listVerification, { reportFailure: false });
  const link = useAtomCommand(linkVerification, { reportFailure: false });
  const unlink = useAtomCommand(unlinkVerification, { reportFailure: false });
  const prepare = useAtomCommand(prepareEvidence, { reportFailure: false });
  const inspectEvidence = useAtomCommand(getEvidence, { reportFailure: false });
  const resource = useAtomCommand(evidenceResource, { reportFailure: false });
  const baseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const [bundle, setBundle] = useState<EvidencePreparation | null>(null);
  const [previousBundle, setPreviousBundle] = useState<{
    receipt: EvidencePreparation;
    error: string | null;
  } | null>(null);
  const [transfers, setTransfers] = useState<ReadonlyArray<EvidenceAssetTransfer>>([]);
  const [draftReceipt, setDraftReceipt] = useState<{ accepted: number; total: number } | null>(
    null,
  );
  const [preparingBundle, setPreparingBundle] = useState(false);
  const bundleEpoch = useRef(0);
  const bundleController = useRef<AbortController | null>(null);
  const [view, setView] = useState<VerificationOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [contextID, setContextID] = useState("");
  const [recordingID, setRecordingID] = useState("");
  const [attemptCapture, setAttemptCapture] = useState<{
    context: RecordingContext;
    receiptID: string;
  } | null>(null);
  const [evidenceID, setEvidenceID] = useState("");
  const epoch = useRef(0);
  const executing = useRef(false);
  const refresh = useCallback(async () => {
    const version = ++epoch.current;
    try {
      const result = await list({ environmentId, input: { reference } });
      if (result._tag === "Failure") throw new Error(Cause.pretty(result.cause));
      if (version === epoch.current) {
        setView(result.value);
        setError(null);
      }
    } catch (cause) {
      if (version === epoch.current) setError(String(cause));
    }
  }, [list, environmentId, reference]);
  useEffect(() => {
    void refresh();
    return () => {
      epoch.current++;
    };
  }, [refresh]);
  const candidate = view?.contexts.find((item) => item.checkout.id === contextID);
  const evidence = view?.evidence.find((item) => item.artifactID === evidenceID);
  const context = evidence?.context ?? candidate?.recordingContext;
  const captureContext = attemptCapture?.context ?? context;
  const resetBundle = () => {
    bundleEpoch.current++;
    bundleController.current?.abort();
    setBundle(null);
    setPreviousBundle(null);
    setTransfers([]);
    setDraftReceipt(null);
    setPreparingBundle(false);
  };
  useEffect(
    () => () => {
      bundleEpoch.current++;
      bundleController.current?.abort();
    },
    [],
  );
  const selectEvidence = (item: Evidence) => {
    resetBundle();
    setEvidenceID(item.artifactID);
    setContextID(item.checkoutID);
    setRecordingID(item.recording.id);
  };
  const mutate = async (action: "link" | "unlink") => {
    if (executing.current || !view) return;
    if (action === "link" && (!candidate || !candidate.recordingContext || !recordingID)) return;
    if (action === "unlink" && !evidence) return;
    executing.current = true;
    setBusy(true);
    setError(null);
    try {
      const result =
        action === "link"
          ? await link({
              environmentId,
              input: {
                reference,
                featureID: candidate!.feature.id,
                checkoutID: candidate!.checkout.id,
                recording: { ...candidate!.recordingContext!, recordingID },
              },
            })
          : await unlink({
              environmentId,
              input: {
                reference,
                featureID: evidence!.featureID,
                checkoutID: evidence!.checkoutID,
                artifactID: evidence!.artifactID,
              },
            });
      if (result._tag === "Failure") throw new Error(Cause.pretty(result.cause));
      setView(result.value);
      if (action === "unlink") setEvidenceID("");
      else {
        const added = result.value.evidence.find(
          (item) => item.context.recordingID === recordingID && item.checkoutID === contextID,
        );
        if (added) setEvidenceID(added.artifactID);
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      executing.current = false;
      setBusy(false);
    }
  };
  const evidenceSummary = () => {
    if (!evidence || !view) return "";
    const lines = [
      `Review evidence for PR #${detail.number}: ${detail.url}`,
      `Current host head: ${view.head ?? "unknown"}; observed ${view.observedAt}.`,
      `Recording: ${evidence.recording.title} (${evidence.recording.id}), ${evidence.recording.createdAt}.`,
      `Captured source: ${labels[evidence.sourceState]}. ${evidence.reason}`,
      `Immutable manifest SHA256: ${evidence.manifestHash}.`,
      `Explicit context: feature ${evidence.featureID}; checkout ${evidence.checkoutID}; computer ${evidence.context.installationID}; workspace ${evidence.context.workspaceID}; generation ${evidence.context.generation}.`,
      `Recorded outcome: ${evidence.recording.checkOutcome}; errors observed ${evidence.recording.errorCount}; warnings ${evidence.recording.warningCount}. Marks are observations, not deterministic test results.`,
      ...evidence.recording.repositories.map(
        (repo) =>
          `Repository ${repo.repositoryID}: ${repo.head ?? "unknown"}; changed files ${repo.changedFiles}; fingerprint ${repo.diffHash ?? "unavailable"}; snapshot ${repo.snapshotComplete ? "complete" : "incomplete"}.`,
      ),
      ...evidence.recording.markers.map(
        (mark) => `Marker ${mark.t.toFixed(2)}s: ${mark.outcome ?? "info"} — ${mark.label}`,
      ),
      "Attachment state: provenance summary prepared. Prepare the video, frames, logs and diff in Cinderdeck, then attach the bundle before asking the agent to assess those assets. Served build revision remains unknown.",
    ];
    return lines.join("\n");
  };
  const prepareDraft = async () => {
    const receipt = await onPrepareDraft(evidenceSummary());
    setDraftReceipt(receipt);
    if (!receipt)
      setError("The composer could not be prepared. Open a conversation and try again.");
  };
  const grantAsset = async (receipt: EvidencePreparation, asset: EvidenceAsset) => {
    if (!evidence || !baseUrl) throw new Error("The execution computer is unavailable.");
    const grant = await resource({
      environmentId,
      input: { ...evidence.context, preparationID: receipt.preparationID, resourceID: asset.id },
    });
    if (grant._tag === "Failure") throw new Error(Cause.pretty(grant.cause));
    if (grant.value.size !== asset.size || grant.value.mimeType !== asset.mimeType)
      throw new Error("Prepared resource changed.");
    const url = new URL(grant.value.path, baseUrl);
    if (url.origin !== new URL(baseUrl).origin || !url.pathname.startsWith("/api/deckhand/"))
      throw new Error("Invalid evidence grant.");
    return url.toString();
  };
  const prepareBundle = async (fresh = false) => {
    if (!evidence || preparingBundle || preparingDraft) return;
    const version = ++bundleEpoch.current;
    bundleController.current?.abort();
    const controller = new AbortController();
    bundleController.current = controller;
    setPreparingBundle(true);
    if (fresh && bundle) {
      setPreviousBundle({
        receipt: bundle,
        error:
          error ??
          transfers
            .filter((item) => item.state === "failed")
            .map((item) => item.detail)
            .join("; "),
      });
      setBundle(null);
      setTransfers([]);
    }
    setError(null);
    setDraftReceipt(null);
    try {
      const storageKey = `deckhand:evidence-prepare:${environmentId}:${evidence.artifactID}`;
      let operationKey = localStorage.getItem(storageKey);
      if (fresh || !operationKey) {
        operationKey = randomUUID();
        localStorage.setItem(storageKey, operationKey);
      }
      const response =
        bundle && !fresh
          ? await inspectEvidence({
              environmentId,
              input: { ...evidence.context, preparationID: bundle.preparationID },
            })
          : await prepare({ environmentId, input: { ...evidence.context, operationKey } });
      if (version !== bundleEpoch.current) return;
      if (response._tag === "Failure") throw new Error(Cause.pretty(response.cause));
      const receipt = response.value;
      setBundle(receipt);
      if (fresh) setTransfers([]);
      if (receipt.state !== "ready") {
        if (receipt.state !== "preparing")
          setError(receipt.detail ?? `Evidence preparation ${receipt.state}.`);
        return;
      }
      const downloaded = await downloadEvidenceAssets(
        receipt.assets,
        async (asset) => {
          const url = await grantAsset(receipt, asset);
          return fetch(url, {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
          });
        },
        controller.signal,
      );
      if (version !== bundleEpoch.current) return;
      setTransfers(downloaded.transfers);
      if (!downloaded.files.length)
        throw new Error(
          "No verified assets could be attached. Review each resource below or prepare the summary.",
        );
      const details = downloaded.transfers
        .map((item) => `${item.asset.name}: ${item.state} — ${item.detail}`)
        .join("\n");
      const prompt = evidenceSummary().replace(
        "Attachment state: provenance summary prepared. Prepare the video, frames, logs and diff in Cinderdeck, then attach the bundle before asking the agent to assess those assets. Served build revision remains unknown.",
        `Attachment state: actual checksum-verified assets prepared below. Composer upload and provider acceptance remain pending. Served build revision remains unknown.\n${details}`,
      );
      const receiptDraft = await onPrepareDraft(prompt, downloaded.files);
      if (version !== bundleEpoch.current) return;
      setDraftReceipt(receiptDraft);
      if (!receiptDraft)
        throw new Error(
          "The composer could not be prepared. Your native evidence bundle is retained.",
        );
    } catch (cause) {
      if (version === bundleEpoch.current)
        setError(cause instanceof Error ? cause.message : "Evidence preparation failed.");
    } finally {
      if (version === bundleEpoch.current) setPreparingBundle(false);
    }
  };
  const downloadAsset = async (asset: EvidenceAsset) => {
    if (!bundle) return;
    try {
      const url = await grantAsset(bundle, asset);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = asset.name;
      anchor.rel = "noreferrer";
      anchor.click();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Resource access failed.");
    }
  };
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <span className={styles.eyebrow}>REVISION AWARE REVIEW</span>
          <h2>See what was verified.</h2>
          <p>Recordings, source snapshots, and agents for this pull request.</p>
        </div>
        <button onClick={() => void refresh()} disabled={busy}>
          <RefreshCwIcon size={14} />
          Refresh PR head
        </button>
      </header>
      <div className={styles.revision}>
        <GitCommitHorizontalIcon size={17} />
        <span>Current PR head</span>
        <code>{view?.head ?? "Unavailable"}</code>
        <span>
          {view
            ? `Observed ${new Date(view.observedAt).toLocaleTimeString()}`
            : "Reading host revision…"}
        </span>
      </div>
      {error ? (
        <div role="alert" className={styles.error}>
          {error}
          <button onClick={() => void refresh()}>Retry</button>
        </div>
      ) : null}
      <div className={styles.layout}>
        <main className={styles.main}>
          {view ? (
            <RecordingScenarioComparison
              key={`${environmentId}:${reference.projectId}:${reference.repository}:${reference.number}`}
              environmentId={environmentId}
              reference={reference}
              view={view}
              onChange={setView}
              onOpen={selectEvidence}
            />
          ) : null}
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <h3>Verification recording</h3>
                <p>
                  {evidence
                    ? labels[evidence.sourceState]
                    : "Select a feature checkout, then a recording to attach."}
                </p>
              </div>
              {evidence ? (
                <span data-state={evidence.sourceState} className={styles.badge}>
                  {evidence.sourceState === "source_match" ? (
                    <CheckIcon size={12} />
                  ) : (
                    <ShieldQuestionIcon size={12} />
                  )}{" "}
                  {labels[evidence.sourceState]}
                </span>
              ) : null}
            </div>
            <div className={styles.choose}>
              <label>
                Feature / checkout
                <select
                  value={contextID}
                  disabled={busy}
                  onChange={(event) => {
                    resetBundle();
                    setAttemptCapture(null);
                    setContextID(event.target.value);
                    setEvidenceID("");
                    setRecordingID("");
                  }}
                >
                  <option value="">Select checkout…</option>
                  {view?.contexts.map((item) => (
                    <option key={item.checkout.id} value={item.checkout.id}>
                      {item.feature.title} · {item.checkout.laneId ?? "Primary"} ·{" "}
                      {item.checkout.state}
                    </option>
                  ))}
                  {contextID && !candidate ? (
                    <option value={contextID}>Saved checkout unavailable</option>
                  ) : null}
                </select>
              </label>
              <button
                disabled={busy || !candidate?.recordingContext || !recordingID}
                onClick={() => void mutate("link")}
              >
                <VideoIcon size={14} />
                Attach selected recording
              </button>
            </div>
            <VerificationAttemptPanel
              key={`${environmentId}:${reference.projectId}:${reference.repository}:${reference.number}:${candidate?.checkout.id ?? "none"}`}
              environmentId={environmentId}
              reference={reference}
              candidate={candidate}
              recordingID={recordingID}
              onCaptureContext={setAttemptCapture}
            />
            {captureContext ? (
              <Recordings
                key={`${captureContext.installationID}:${captureContext.workspaceID}:${captureContext.generation}:${attemptCapture?.receiptID ?? evidence?.artifactID ?? contextID}`}
                environmentId={environmentId}
                context={captureContext}
                buildReceiptID={attemptCapture?.receiptID}
                initialRecordingID={recordingID || undefined}
                onSelectRecording={(id) => {
                  setRecordingID(id);
                  setEvidenceID("");
                }}
              />
            ) : (
              <div className={styles.empty}>
                <VideoIcon size={30} />
                <h3>
                  {view?.contexts.length
                    ? "Choose a checkout to review its evidence"
                    : "No linked feature checkout"}
                </h3>
                <p>
                  A matching repository must be registered with a feature before recording evidence
                  can be attached. PR checks remain available in Summary.
                </p>
              </div>
            )}
          </section>
          {evidence ? (
            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <h3>Captured provenance</h3>
                  <p>{evidence.reason}</p>
                </div>
                <button disabled={busy} onClick={() => void mutate("unlink")}>
                  <UnlinkIcon size={14} />
                  Unlink
                </button>
              </div>
              <div className={styles.provenance}>
                <div className={styles.bundleActions}>
                  <button
                    disabled={preparingDraft || preparingBundle}
                    onClick={() => void prepareBundle()}
                  >
                    <VideoIcon size={14} />
                    {preparingBundle
                      ? "Preparing evidence…"
                      : bundle?.state === "preparing"
                        ? "Check preparation"
                        : "Prepare evidence bundle"}
                  </button>
                  <button
                    disabled={preparingDraft || preparingBundle}
                    onClick={() => void prepareDraft()}
                  >
                    <ArrowUpRightIcon size={14} />
                    Summary only
                  </button>
                  {bundle && bundle.state !== "preparing" ? (
                    <button
                      disabled={preparingDraft || preparingBundle}
                      onClick={() => void prepareBundle(true)}
                    >
                      Prepare a new bundle
                    </button>
                  ) : null}
                </div>
                <p className={styles.hint}>
                  Prepares a reviewable composer draft with verified assets. The composer shows
                  upload and provider support before you send.
                </p>
                {previousBundle ? (
                  <p className={styles.hint}>
                    Previous preparation {previousBundle.receipt.preparationID} is retained (
                    {previousBundle.receipt.state}). {previousBundle.error ?? ""}
                  </p>
                ) : null}
                {bundle ? (
                  <div className={styles.assets}>
                    <p>
                      Native bundle: {bundle.state} {bundle.detail ?? ""}
                    </p>
                    {bundle.assets.map((asset) => {
                      const transfer = transfers.find((item) => item.asset.id === asset.id);
                      return (
                        <div key={asset.id}>
                          <span>
                            <strong>{asset.name}</strong>
                            <small>
                              {asset.kind} · {(asset.size / 1024).toFixed(1)} KB ·{" "}
                              {transfer?.state ?? asset.state}
                            </small>
                            <small>{transfer?.detail ?? asset.detail ?? ""}</small>
                          </span>
                          {asset.state === "ready" ? (
                            <button onClick={() => void downloadAsset(asset)}>Download</button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                {draftReceipt ? (
                  <p role="status">
                    Composer accepted {draftReceipt.accepted} of {draftReceipt.total} assets. Review
                    upload progress and provider support before sending.
                  </p>
                ) : null}
                <p>
                  <span>Capture clock</span>
                  <strong>
                    {String(
                      "clockQuality" in evidence.recording
                        ? (evidence.recording.clockQuality ?? "unknown")
                        : "unknown",
                    )}
                  </strong>
                </p>
                <p>
                  <span>Served build</span>
                  <strong>Unknown — no captured build revision proof</strong>
                </p>
                <p>
                  <span>Snapshot digest</span>
                  <code>{evidence.manifestHash}</code>
                </p>
                {evidence.recording.repositories.map((repo) => (
                  <p
                    key={`${repo.workspaceID}:${repo.repositoryID}:${repo.repositoryPhysicalId ?? "unknown"}`}
                  >
                    <span>{repo.repositoryID}</span>
                    <code>{repo.head ?? "Unknown commit"}</code>
                    <strong>
                      {repo.snapshotComplete ? "Complete source snapshot" : "Incomplete snapshot"} ·{" "}
                      {repo.changedFiles} changed files
                    </strong>
                  </p>
                ))}
              </div>
            </section>
          ) : null}
        </main>
        <aside className={styles.aside}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <h3>Pull request</h3>
            </div>
            <div className={styles.summary}>
              <strong>{detail.title}</strong>
              <p>
                {detail.headBranch} → {detail.baseBranch}
              </p>
              <p>
                {detail.state} · {detail.changedFiles} files changed
              </p>
              <a href={detail.url} target="_blank" rel="noreferrer">
                Open on {detail.provider}
                <ArrowUpRightIcon size={13} />
              </a>
            </div>
          </section>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <h3>Attached recordings</h3>
              <span>{view?.evidence.length ?? 0}</span>
            </div>
            {view?.evidence.length ? (
              view.evidence.map((item) => (
                <button
                  key={`${item.artifactID}:${item.featureID}:${item.checkoutID}`}
                  className={styles.recording}
                  data-selected={item.artifactID === evidenceID}
                  onClick={() => selectEvidence(item)}
                >
                  <VideoIcon size={16} />
                  <span>
                    <strong>{item.recording.title}</strong>
                    <small>{new Date(item.recording.createdAt).toLocaleString()}</small>
                    <small>
                      {labels[item.sourceState]} · {item.recording.checkOutcome}
                    </small>
                  </span>
                </button>
              ))
            ) : (
              <p className={styles.hint}>No evidence attached yet.</p>
            )}
          </section>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <h3>Feature agents</h3>
            </div>
            {view?.sessions.length ? (
              view.sessions.map((session) => (
                <Link
                  key={session.id}
                  to="/$environmentId/$threadId"
                  params={buildThreadRouteParams({ environmentId, threadId: session.threadId })}
                  className={styles.agent}
                >
                  <span className={styles.dot} data-state={session.connection} />
                  <span>
                    <strong>{session.role}</strong>
                    <small>
                      {session.execution.replaceAll("_", " ")} · {session.connection}
                    </small>
                  </span>
                  <ArrowUpRightIcon size={13} />
                </Link>
              ))
            ) : (
              <p className={styles.hint}>No managed agents for linked features.</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
