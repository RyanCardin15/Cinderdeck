import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EnvironmentId } from "@cinderdeck/contracts";
import type { IntegrationView, OperationRecord } from "@cinderdeck/contracts/deckhand/rpc";
import { OperationRecord as OperationRecordSchema } from "@cinderdeck/contracts/deckhand/rpc";
import type { IntegrationOperationInput } from "@cinderdeck/contracts/deckhand/integration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { runtime } from "../lib/runtime";
import { useAtomCommand } from "../state/use-atom-command";
import { inspectOperation, recentOperations, submitOperation } from "./state";
import styles from "./workspace.module.css";

type Resource = IntegrationView["resources"][number];
type LifecycleMethod = "lane.setup" | "lane.release" | "lane.remove";
type Props = {
  environmentId: EnvironmentId;
  installationID: string;
  resource: Resource;
  capabilities: readonly string[];
  enabled: boolean;
  onPending?: (pending: boolean) => void;
};
const lifecycle = (method: string): method is LifecycleMethod =>
  ["lane.setup", "lane.release", "lane.remove"].includes(method);
const unresolved = (record: OperationRecord) =>
  !record.refused &&
  (!record.receipt || ["pending", "running", "unknown_outcome"].includes(record.receipt.state));
const savedKey = (props: Props) =>
  `deckhand.lane-lifecycle:${JSON.stringify([props.environmentId, props.installationID, props.resource.workspaceID])}`;
const decodeSavedRecord = Schema.decodeUnknownSync(OperationRecordSchema);
function readSaved(key: string): OperationRecord | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? decodeSavedRecord(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
function save(key: string, record: OperationRecord | null) {
  try {
    if (record) localStorage.setItem(key, JSON.stringify(record));
    else localStorage.removeItem(key);
  } catch {
    // The server journal remains authoritative when browser storage is unavailable.
  }
}
function resultLabel(record: OperationRecord) {
  const action = record.input.method === "lane.setup" ? "Setup" : "Lane removal";
  if (record.refused) return `${action} refused`;
  const receipt = record.receipt;
  if (!receipt || receipt.state === "unknown_outcome") return `${action} outcome unknown`;
  if (receipt.state === "failed") return `${action} failed`;
  if (receipt.state === "pending" || receipt.state === "running")
    return `${action} ${receipt.state === "pending" ? "pending" : "running"}`;
  if (record.input.method === "lane.setup") {
    const status = receipt.result?.setup?.status;
    return status === "succeeded"
      ? "Setup succeeded"
      : status === "failed"
        ? "Setup failed"
        : status === "skipped"
          ? "Setup skipped"
          : status === "running" || status === "pending"
            ? `Setup ${status}`
            : "Setup result unavailable";
  }
  return receipt.result?.released || receipt.result?.removed
    ? "Lane removed from Cinderdeck"
    : "Lane removal result unavailable";
}

/** Each mounted panel owns one lane's saved requests, including responses received after navigation. */
export function LaneLifecycleControls(props: Props) {
  return (
    <LaneLifecyclePanel
      key={JSON.stringify([
        props.environmentId,
        props.installationID,
        props.resource.workspaceID,
        props.resource.generation,
      ])}
      {...props}
    />
  );
}

function LaneLifecyclePanel(props: Props) {
  const { environmentId, installationID, resource, capabilities, enabled, onPending } = props;
  const storageKey = savedKey(props);
  const [operation, setOperation] = useState(() => {
    const saved = readSaved(storageKey);
    return saved &&
      lifecycle(saved.input.method) &&
      saved.input.installationID === installationID &&
      saved.input.workspaceID === resource.workspaceID
      ? saved
      : null;
  });
  const [recovered, setRecovered] = useState(false);
  const [recoveryError, setRecoveryError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleteWorktrees, setDeleteWorktrees] = useState(false);
  const [discardIgnored, setDiscardIgnored] = useState(false);
  const mounted = useRef(true);
  const current = useRef(props);
  useLayoutEffect(() => {
    current.current = props;
  }, [props]);
  const submit = useAtomCommand(submitOperation, { reportFailure: false });
  const inspect = useAtomCommand(inspectOperation, { reportFailure: false });
  const recent = useAtomCommand(recentOperations, { reportFailure: false });
  const receiptsSupported = capabilities.includes("operations.receipts");
  const pending =
    busy ||
    (receiptsSupported && (!recovered || recoveryError)) ||
    (operation !== null && unresolved(operation));
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onPending?.(pending);
    return () => onPending?.(false);
  }, [onPending, pending]);
  useEffect(() => {
    if (recovered || recoveryError || !receiptsSupported) return;
    let disposed = false;
    void recent({ environmentId, input: {} })
      .catch(() => null)
      .then((response) => {
        if (disposed) return;
        if (response?._tag !== "Success") {
          setRecoveryError(true);
          return;
        }
        const records = response.value.filter(
          (record) =>
            record.input.installationID === installationID &&
            record.input.workspaceID === resource.workspaceID &&
            lifecycle(record.input.method),
        );
        setOperation((saved) => {
          const savedRecord = records.find(
            (record) => record.input.operationKey === saved?.input.operationKey,
          );
          const next = records.find(unresolved) ?? savedRecord ?? saved;
          if (next) save(storageKey, next);
          return next;
        });
        setRecovered(true);
      });
    return () => {
      disposed = true;
    };
  }, [
    environmentId,
    installationID,
    resource.workspaceID,
    recent,
    receiptsSupported,
    recovered,
    recoveryError,
    storageKey,
  ]);

  const name = resource.workspace?.lane?.name ?? resource.workspace?.name ?? "this lane";
  const namedLane = Boolean(resource.workspace?.lane);
  const sourceReady =
    enabled &&
    resource.available &&
    namedLane &&
    !resource.workspace?.definitionChanged &&
    !resource.workspace?.issues.length &&
    receiptsSupported &&
    recovered &&
    !recoveryError;
  const ready = sourceReady && !pending;
  const supported = (method: LifecycleMethod) => capabilities.includes(`operations.${method}`);
  const accept = (record: OperationRecord) => {
    // Persist using the original scope even if this panel was unmounted by a lane switch.
    save(storageKey, record);
    if (mounted.current) setOperation(record);
  };
  const send = async (record: OperationRecord) => {
    accept(record);
    setBusy(true);
    setMessage(null);
    const response = await submit({ environmentId, input: record.input }).catch(() => null);
    if (response?._tag === "Success") {
      accept({ ...record, receipt: response.value });
    } else {
      const records = await recent({ environmentId, input: {} }).catch(() => null);
      const saved =
        records?._tag === "Success"
          ? records.value.find((item) => item.input.operationKey === record.input.operationKey)
          : undefined;
      accept(saved ?? record);
      if (mounted.current)
        setMessage(
          saved?.refused
            ? "Cinderdeck refused this request. Refresh the lane before trying again."
            : "The reply was lost. Check the saved request before taking another action.",
        );
    }
    if (mounted.current) setBusy(false);
  };
  const begin = async (method: LifecycleMethod) => {
    if (!ready || !supported(method)) return;
    setBusy(true);
    const revision = resource.revision;
    try {
      const operationKey = await runtime.runPromise(
        Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
      );
      if (!mounted.current) return;
      const latest = current.current;
      if (
        !latest.enabled ||
        latest.resource.revision !== revision ||
        !latest.resource.available ||
        latest.resource.workspace?.definitionChanged ||
        latest.resource.workspace?.issues.length ||
        !latest.capabilities.includes(`operations.${method}`) ||
        !latest.capabilities.includes("operations.receipts")
      ) {
        setBusy(false);
        setMessage("The lane changed. Refresh its state before taking this action.");
        return;
      }
      const input: IntegrationOperationInput = {
        operationKey,
        installationID,
        workspaceID: resource.workspaceID,
        generation: resource.generation,
        revision,
        method,
        arguments: {
          workspace: resource.workspaceID,
          ...(method === "lane.remove" ? { discard_ignored: discardIgnored } : {}),
        },
      };
      setConfirming(false);
      await send({
        input,
        receipt: null,
        refused: false,
        error: null,
        createdAt: new Date().toISOString(),
      });
    } catch {
      if (mounted.current) {
        setBusy(false);
        setMessage("The request could not be prepared. No action was sent.");
      }
    }
  };
  const reconcile = async () => {
    if (!operation || busy || !receiptsSupported) return;
    setBusy(true);
    const response = await inspect({
      environmentId,
      input: {
        operationKey: operation.input.operationKey,
        ...(capabilities.includes("operations.receipts.wait") ? { waitMs: 25000 } : {}),
      },
    }).catch(() => null);
    if (response?._tag === "Success") accept({ ...operation, receipt: response.value });
    else {
      const records = await recent({ environmentId, input: {} }).catch(() => null);
      const saved =
        records?._tag === "Success"
          ? records.value.find(
              (record) => record.input.operationKey === operation.input.operationKey,
            )
          : undefined;
      if (saved) accept(saved);
      if (mounted.current)
        setMessage(
          saved?.refused
            ? "Cinderdeck refused this request. Refresh the lane before trying again."
            : "The saved result could not be confirmed. Its outcome remains unknown.",
        );
    }
    if (mounted.current) setBusy(false);
  };
  const sameOriginalScope =
    operation &&
    operation.input.installationID === installationID &&
    operation.input.workspaceID === resource.workspaceID &&
    operation.input.generation === resource.generation &&
    operation.input.revision === resource.revision;
  return (
    <section aria-label="Lane setup and removal">
      <h3>Lane setup and removal</h3>
      {namedLane ? (
        <p>Run this lane’s configured setup tasks, or remove it when you’re finished.</p>
      ) : null}
      {!namedLane && !operation ? <p>Select a named lane to set it up or remove it.</p> : null}
      <div className={styles["dh-inspector-actions"]}>
        <button
          className={styles["dh-button"]}
          disabled={!ready || !supported("lane.setup")}
          onClick={() => void begin("lane.setup")}
        >
          Run setup
        </button>
        <button
          className={styles["dh-button"]}
          disabled={!ready || (!supported("lane.release") && !supported("lane.remove"))}
          onClick={() => {
            setDeleteWorktrees(false);
            setDiscardIgnored(false);
            setConfirming(true);
          }}
        >
          Remove lane…
        </button>
      </div>
      {!enabled && namedLane ? (
        <p>Fresh Cinderdeck state is required to change this lane.</p>
      ) : null}
      {!receiptsSupported ? (
        <p>This Cinderdeck version cannot confirm lane actions. Update it to continue.</p>
      ) : recoveryError ? (
        <p role="alert">
          Previous lane requests are unavailable.{" "}
          <button className={styles["dh-button"]} onClick={() => setRecoveryError(false)}>
            Check previous requests
          </button>
        </p>
      ) : !recovered ? (
        <p role="status">Checking previous lane requests…</p>
      ) : null}
      {confirming ? (
        <fieldset disabled={busy}>
          <legend>Remove {name}</legend>
          <p>
            Stop this lane’s services and remove it from Cinderdeck. Branches and logs are kept.
            Adopted and shared worktrees are kept.
          </p>
          <label className={styles["dh-field-label"]}>
            <input
              type="radio"
              name={`remove-${resource.workspaceID}`}
              checked={!deleteWorktrees}
              onChange={() => {
                setDeleteWorktrees(false);
                setDiscardIgnored(false);
              }}
            />{" "}
            Keep worktrees and their files
          </label>
          <label className={styles["dh-field-label"]}>
            <input
              type="radio"
              name={`remove-${resource.workspaceID}`}
              checked={deleteWorktrees}
              onChange={() => setDeleteWorktrees(true)}
            />{" "}
            Delete eligible managed worktrees
          </label>
          {deleteWorktrees ? (
            <label className={styles["dh-field-label"]}>
              <input
                type="checkbox"
                checked={discardIgnored}
                onChange={(event) => setDiscardIgnored(event.target.checked)}
              />{" "}
              Also delete ignored files and changed copied files in those worktrees
            </label>
          ) : null}
          <p>
            Active agents, runs and shared services can prevent removal.
            {deleteWorktrees
              ? " Changed source files prevent worktree deletion."
              : " Your worktree files will be preserved."}
          </p>
          <div className={styles["dh-inspector-actions"]}>
            <button
              className={styles["dh-button"]}
              disabled={!ready || !supported(deleteWorktrees ? "lane.remove" : "lane.release")}
              onClick={() => void begin(deleteWorktrees ? "lane.remove" : "lane.release")}
            >
              Remove {name}
            </button>
            <button className={styles["dh-button"]} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </fieldset>
      ) : null}
      {operation ? (
        <div className={styles["dh-operation"]} role="status">
          <strong>{resultLabel(operation)}</strong>
          {operation.receipt?.result?.setup?.detail || operation.receipt?.error?.message ? (
            <p>{operation.receipt?.result?.setup?.detail ?? operation.receipt?.error?.message}</p>
          ) : null}
          {operation.receipt?.result?.report ? (
            <p>
              {operation.receipt.result.report.removedWorktrees.length} worktrees deleted;{" "}
              {operation.receipt.result.report.keptWorktrees.length} kept. Branches and logs were
              kept.
            </p>
          ) : null}
          {!sameOriginalScope ? (
            <p>
              This request belongs to the lane state where it was started. Checking it does not
              change the current lane.
            </p>
          ) : null}
          {unresolved(operation) ? (
            <>
              <button
                className={styles["dh-button"]}
                disabled={busy || !receiptsSupported}
                onClick={() => void reconcile()}
              >
                Check result
              </button>
              {!operation.receipt && sameOriginalScope ? (
                <button
                  className={styles["dh-button"]}
                  disabled={
                    busy || !sourceReady || !supported(operation.input.method as LifecycleMethod)
                  }
                  onClick={() => void send(operation)}
                >
                  Send saved request
                </button>
              ) : null}
            </>
          ) : (
            <button
              className={styles["dh-button"]}
              disabled={busy}
              onClick={() => {
                save(storageKey, null);
                setOperation(null);
                setMessage(null);
                setRecovered(false);
              }}
            >
              Done
            </button>
          )}
        </div>
      ) : null}
      {message ? <p role="alert">{message}</p> : null}
    </section>
  );
}
