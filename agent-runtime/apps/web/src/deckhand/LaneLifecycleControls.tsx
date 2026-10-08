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
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../components/ui/dialog";
import styles from "./workspace.module.css";
import removalStyles from "./laneRemoval.module.css";

type Resource = IntegrationView["resources"][number];
type LifecycleMethod = "lane.setup" | "lane.release" | "lane.remove";
type Props = {
  environmentId: EnvironmentId;
  installationID: string;
  resource: Resource;
  capabilities: readonly string[];
  enabled: boolean;
  onPending?: (pending: boolean) => void;
  onWorking?: (working: boolean) => void;
  mode?: "all" | "remove";
  onCancel?: () => void;
  onRemoved?: () => void;
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
  const {
    environmentId,
    installationID,
    resource,
    capabilities,
    enabled,
    onPending,
    onWorking,
    mode = "all",
    onCancel,
    onRemoved,
  } = props;
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
  const [confirming, setConfirming] = useState(mode === "remove");
  const [removalOpen, setRemovalOpen] = useState(mode === "remove");
  const [deleteWorktrees, setDeleteWorktrees] = useState(false);
  const [discardIgnored, setDiscardIgnored] = useState(false);
  const mounted = useRef(true);
  const preparing = useRef(false);
  const current = useRef(props);
  const notifiedRemoval = useRef<string | null>(null);
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
    onWorking?.(busy);
    return () => onWorking?.(false);
  }, [onWorking, busy]);
  useEffect(() => {
    if (
      operation?.receipt?.state === "succeeded" &&
      ["lane.release", "lane.remove"].includes(operation.input.method) &&
      operation.input.generation === resource.generation &&
      (operation.receipt.result?.released === resource.workspaceID ||
        operation.receipt.result?.removed === resource.workspaceID) &&
      notifiedRemoval.current !== operation.input.operationKey
    ) {
      notifiedRemoval.current = operation.input.operationKey;
      onRemoved?.();
    }
  }, [operation, resource.generation, resource.workspaceID, onRemoved]);
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
  const cleanupReady = enabled && namedLane && receiptsSupported && recovered && !recoveryError;
  const sourceReady =
    cleanupReady &&
    resource.available &&
    !resource.workspace?.definitionChanged &&
    !resource.workspace?.issues.length;
  const ready = sourceReady && !pending;
  const removalReady = cleanupReady && !pending;
  const methodReady = (method: LifecycleMethod) =>
    method === "lane.setup" ? sourceReady : cleanupReady;
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
    if (!methodReady(method) || pending || !supported(method) || preparing.current) return;
    preparing.current = true;
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
        latest.resource.generation !== resource.generation ||
        !latest.resource.workspace?.lane ||
        (method === "lane.setup" &&
          (!latest.resource.available ||
            latest.resource.workspace?.definitionChanged ||
            latest.resource.workspace?.issues.length)) ||
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
    } finally {
      preparing.current = false;
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
  const cancel = () => {
    if (busy) return;
    setConfirming(false);
    setRemovalOpen(false);
    onCancel?.();
  };
  const availability = (
    <>
      {!enabled && namedLane ? <p role="status">Refresh the lane to continue.</p> : null}
      {!receiptsSupported ? (
        <p role="status">Update Cinderdeck to confirm lane actions.</p>
      ) : recoveryError ? (
        <div role="alert">
          <p>Previous lane requests are unavailable.</p>
          <Button variant="outline" onClick={() => setRecoveryError(false)}>
            Check previous requests
          </Button>
        </div>
      ) : !recovered ? (
        <p role="status">Checking previous lane requests…</p>
      ) : null}
    </>
  );
  const operationStatus = operation ? (
    <div className={removalStyles.result} role="status">
      <strong>{resultLabel(operation)}</strong>
      {operation.receipt?.result?.setup?.detail || operation.receipt?.error?.message ? (
        <p>{operation.receipt?.result?.setup?.detail ?? operation.receipt?.error?.message}</p>
      ) : null}
      {operation.receipt?.result?.report ? (
        <p>
          {operation.receipt.result.report.removedWorktrees.length} worktrees deleted;{" "}
          {operation.receipt.result.report.keptWorktrees.length} kept. Branches and logs were kept.
        </p>
      ) : null}
      {!sameOriginalScope ? (
        <p>
          This request belongs to the lane state where it was started. Checking it does not change
          the current lane.
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
                busy ||
                !methodReady(operation.input.method as LifecycleMethod) ||
                !supported(operation.input.method as LifecycleMethod)
              }
              onClick={() => void send(operation)}
            >
              Send saved request
            </button>
          ) : null}
        </>
      ) : (
        <>
          {operation.receipt?.state === "failed" && operation.input.method !== "lane.setup" ? (
            <Button
              variant="outline"
              disabled={!removalReady}
              onClick={() => {
                setDeleteWorktrees(false);
                setDiscardIgnored(false);
                setConfirming(true);
                setRemovalOpen(true);
                setMessage(null);
              }}
            >
              Try removal again
            </Button>
          ) : null}
          <button
            className={styles["dh-button"]}
            disabled={busy}
            onClick={() => {
              save(storageKey, null);
              setOperation(null);
              setMessage(null);
              setRecovered(false);
              setRemovalOpen(false);
              setConfirming(false);
              if (mode === "remove") onCancel?.();
            }}
          >
            Done
          </button>
        </>
      )}
    </div>
  ) : null;
  const removalContent = (
    <>
      <DialogHeader>
        <DialogTitle>Remove lane “{name}”?</DialogTitle>
        <DialogDescription>
          This lane’s services will stop. Choose what happens to its files.
        </DialogDescription>
      </DialogHeader>
      <div className={removalStyles.body}>
        {availability}
        {confirming ? (
          <fieldset className={removalStyles.choices} disabled={busy}>
            <legend className={removalStyles.legend}>Worktree files</legend>
            <label className={removalStyles.choice}>
              <input
                type="radio"
                name={`remove-${resource.workspaceID}`}
                checked={!deleteWorktrees}
                onChange={() => {
                  setDeleteWorktrees(false);
                  setDiscardIgnored(false);
                }}
              />
              <span>
                <strong>Keep worktrees and their files</strong>
                <span>Remove the lane from Cinderdeck. Leave its folders on disk.</span>
              </span>
            </label>
            <label className={removalStyles.choice}>
              <input
                type="radio"
                name={`remove-${resource.workspaceID}`}
                checked={deleteWorktrees}
                onChange={() => setDeleteWorktrees(true)}
              />
              <span>
                <strong>Delete managed worktrees</strong>
                <span>
                  Delete folders created for this lane. Changed source files block deletion.
                </span>
              </span>
            </label>
            {deleteWorktrees ? (
              <label className={removalStyles.extra}>
                <input
                  type="checkbox"
                  checked={discardIgnored}
                  onChange={(event) => setDiscardIgnored(event.target.checked)}
                />
                <span>
                  <strong>Also delete ignored and changed copied files</strong>
                  <span>Includes local configuration and build output in these worktrees.</span>
                </span>
              </label>
            ) : null}
            <p className={removalStyles.note}>
              Git branches, logs, and adopted or shared worktrees are kept. Active agents, runs, or
              shared services may prevent removal.
            </p>
          </fieldset>
        ) : null}
        {operationStatus}
        {message ? (
          <p className={removalStyles.error} role="alert">
            {message}
          </p>
        ) : null}
      </div>
      {confirming ? (
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={cancel}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!removalReady || !supported(deleteWorktrees ? "lane.remove" : "lane.release")}
            onClick={() => void begin(deleteWorktrees ? "lane.remove" : "lane.release")}
          >
            {busy ? "Removing…" : deleteWorktrees ? "Delete lane & worktrees" : "Remove lane"}
          </Button>
        </DialogFooter>
      ) : null}
    </>
  );
  return (
    <section
      className={`${removalStyles.panel} ${mode === "remove" ? removalStyles.dialogContent : ""}`}
      aria-label={mode === "remove" ? "Lane removal" : "Lane setup and removal"}
    >
      {mode === "all" ? (
        <>
          <h3>Lane setup and removal</h3>
          <p>
            {namedLane
              ? "Run this lane’s setup tasks, or remove it when you’re finished."
              : "Select a named lane to set it up or remove it."}
          </p>
          <div className={styles["dh-inspector-actions"]}>
            <Button
              variant="outline"
              disabled={!ready || !supported("lane.setup")}
              onClick={() => void begin("lane.setup")}
            >
              Run setup
            </Button>
            <Button
              variant="outline"
              disabled={!removalReady || (!supported("lane.release") && !supported("lane.remove"))}
              onClick={() => {
                setDeleteWorktrees(false);
                setDiscardIgnored(false);
                setConfirming(true);
                setRemovalOpen(true);
              }}
            >
              Remove lane…
            </Button>
          </div>
          {!removalOpen ? (
            <>
              {availability}
              {operationStatus}
              {message ? <p role="alert">{message}</p> : null}
            </>
          ) : null}
          <Dialog
            open={removalOpen}
            onOpenChange={(open) => {
              if (!open) cancel();
            }}
          >
            <DialogPopup showCloseButton={!busy}>{removalContent}</DialogPopup>
          </Dialog>
        </>
      ) : (
        removalContent
      )}
    </section>
  );
}
