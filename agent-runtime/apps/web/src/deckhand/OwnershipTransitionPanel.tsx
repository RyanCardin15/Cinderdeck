import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";
import type { EnvironmentId, ThreadId } from "@cinderdeck/contracts";
import type * as C from "@cinderdeck/contracts/deckhand/ownershipRpc";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useThreadShells } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { randomUUID } from "../lib/utils";
import { workspaceView } from "./state";
import { ownershipPreview, ownershipSubmit, ownershipGet, ownershipList } from "./ownershipState";
import styles from "./ownership.module.css";
export function OwnershipTransitionPanel({
  environmentId,
  embedded = false,
}: {
  environmentId?: EnvironmentId | null;
  embedded?: boolean;
} = {}) {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const [chosenEnvironmentID, setEnvironmentID] = useState<EnvironmentId | null>(primary);
  const environmentID = environmentId === undefined ? chosenEnvironmentID : environmentId;
  const [threadID, setThreadID] = useState<ThreadId | null>(null);
  const [threadLimit, setThreadLimit] = useState(20);
  const selected = environments.find((item) => item.environmentId === environmentID);
  const threads = useThreadShells().filter(
    (item) =>
      item.environmentId === environmentID && item.worktreePath !== null && item.deletedAt === null,
  );
  return (
    <section
      className={`${styles.panel} ${embedded ? styles.embedded : ""}`}
      id={embedded ? undefined : "workspace-ownership"}
      aria-label="Workspace ownership"
    >
      {embedded ? null : <h3>Choose who manages a worktree</h3>}
      <p>
        Adopt an existing worktree into Cinderdeck, or release a lane while keeping its files and
        conversations. Stop all work first. Switching computers or disconnecting does not change
        ownership.
      </p>
      <div className={styles.fields}>
        {environmentId === undefined ? (
          <label>
            Execution computer
            <select
              value={environmentID ?? ""}
              onChange={(event) => {
                setEnvironmentID(
                  environments.find((item) => item.environmentId === event.target.value)
                    ?.environmentId ?? null,
                );
                setThreadID(null);
                setThreadLimit(20);
              }}
            >
              <option value="">Choose a computer</option>
              {environmentID && !selected ? (
                <option value={environmentID}>Unavailable computer</option>
              ) : null}
              {environments.map((item) => (
                <option key={item.environmentId} value={item.environmentId}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          Conversation in the worktree
          <select
            value={threadID ?? ""}
            onChange={(event) =>
              setThreadID(threads.find((item) => item.id === event.target.value)?.id ?? null)
            }
          >
            <option value="">Choose a conversation</option>
            {threads.slice(0, threadLimit).map((item) => (
              <option key={item.id} value={item.id}>
                {item.title || "Untitled conversation"}
              </option>
            ))}
          </select>
        </label>
      </div>
      {threads.length > threadLimit ? (
        <button type="button" onClick={() => setThreadLimit((value) => value + 20)}>
          Show more conversations
        </button>
      ) : null}
      {selected?.connection.phase !== "connected" ? (
        <p role="status">Reconnect the selected execution computer to change ownership.</p>
      ) : threadID ? (
        <OwnershipTransitionForm
          key={`${environmentID}:${threadID}`}
          environmentID={selected.environmentId}
          threadID={threadID}
        />
      ) : (
        <p>
          Choose an existing Git worktree conversation. Projects without a separate worktree and
          multi-repository transitions are currently unavailable.
        </p>
      )}
    </section>
  );
}
export function OwnershipTransitionForm({
  environmentID,
  threadID,
}: {
  environmentID: EnvironmentId;
  threadID: ThreadId;
}) {
  const [offset, setOffset] = useState(0);
  const result = useAtomValue(
    workspaceView({ environmentId: environmentID, input: { offset, limit: 20 } }),
  );
  const view = Option.getOrNull(AsyncResult.value(result));
  const previewCommand = useAtomCommand(ownershipPreview, { reportFailure: false });
  const submit = useAtomCommand(ownershipSubmit, { reportFailure: false });
  const get = useAtomCommand(ownershipGet, { reportFailure: false });
  const list = useAtomCommand(ownershipList, { reportFailure: false });
  const [direction, setDirection] = useState<C.OwnershipIntent["direction"]>("adopt");
  const [workspaceID, setWorkspaceID] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<C.OwnershipPreview | null>(null);
  const [record, setRecord] = useState<C.OwnershipRecord | null>(null);
  const [records, setRecords] = useState<C.OwnershipRecord[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const resources =
    view?.resources.filter(
      (item) =>
        item.available &&
        item.workspace &&
        (direction === "adopt" ? !item.workspace.lane : Boolean(item.workspace.lane)),
    ) ?? [];
  const selected = resources.find((item) => item.workspaceID === workspaceID);
  const receiptState = record?.state;
  const receiptID = record?.id;
  useEffect(() => {
    if (receiptState === "pending" || receiptState === "unknown_outcome") return;
    let active = true;
    void list({
      environmentId: environmentID,
      input: { threadId: threadID, offset: 0, limit: 20 },
    }).then((value) => {
      if (active && value._tag === "Success") setRecords([...value.value.items]);
    });
    return () => {
      active = false;
    };
  }, [environmentID, threadID, list, receiptState]);
  useEffect(() => {
    if (!receiptID || !receiptState || !["pending", "unknown_outcome"].includes(receiptState))
      return;
    let active = true;
    const timer = window.setInterval(() => {
      void get({ environmentId: environmentID, input: { id: receiptID } }).then((value) => {
        if (active && value._tag === "Success") setRecord(value.value);
      });
    }, 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [environmentID, get, receiptID, receiptState]);
  const pending = record && ["pending", "unknown_outcome"].includes(record.state);
  const reset = () => {
    setPreview(null);
    key.current = null;
    setError(null);
  };
  const inspect = async () => {
    if (!selected || !view?.hello) return;
    setBusy(true);
    setError(null);
    key.current ??= randomUUID();
    const intent: C.OwnershipIntent = {
      operationKey: key.current,
      threadId: threadID,
      direction,
      installationID: view.hello.installationID,
      workspaceID: selected.workspaceID,
      generation: selected.generation,
      revision: selected.revision,
      ...(direction === "adopt" && name.trim() ? { laneName: name.trim() } : {}),
    };
    const value = await previewCommand({ environmentId: environmentID, input: intent });
    setBusy(false);
    if (value._tag === "Success") setPreview(value.value);
    else setError("Preview unavailable.");
  };
  const confirm = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    const value = await submit({
      environmentId: environmentID,
      input: { ...preview.intent, preview },
    });
    setBusy(false);
    if (value._tag === "Success") setRecord(value.value);
    else setError("Ownership change unavailable.");
  };
  const recover = async (id: string) => {
    setBusy(true);
    setError(null);
    const value = await get({ environmentId: environmentID, input: { id } });
    setBusy(false);
    if (value._tag === "Success") setRecord(value.value);
    else setError("Receipt recovery unavailable.");
  };
  return (
    <div className={styles.form}>
      <div className={styles.fields}>
        <label>
          Ownership change
          <select
            disabled={Boolean(pending)}
            value={direction}
            onChange={(event) => {
              setDirection(event.target.value === "release" ? "release" : "adopt");
              setWorkspaceID("");
              reset();
            }}
          >
            <option value="adopt">Adopt into Cinderdeck</option>
            <option value="release">Release to standalone</option>
          </select>
        </label>
        <label>
          {direction === "adopt" ? "Cinderdeck base workspace" : "Cinderdeck lane"}
          <select
            disabled={Boolean(pending)}
            value={workspaceID}
            onChange={(event) => {
              setWorkspaceID(event.target.value);
              reset();
            }}
          >
            <option value="">Choose a workspace</option>
            {workspaceID && !selected ? (
              <option value={workspaceID}>Unavailable selection — choose again</option>
            ) : null}
            {resources.map((item) => (
              <option key={item.workspaceID} value={item.workspaceID}>
                {item.workspace?.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {direction === "adopt" ? (
        <label>
          Lane name (optional)
          <input
            disabled={Boolean(pending)}
            maxLength={200}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              reset();
            }}
          />
        </label>
      ) : null}
      <div className={styles.actions}>
        <button
          type="button"
          disabled={offset === 0 || Boolean(pending)}
          onClick={() => {
            setOffset((value) => Math.max(0, value - 20));
            setWorkspaceID("");
            reset();
          }}
        >
          Previous workspaces
        </button>
        <button
          type="button"
          disabled={view?.nextOffset == null || Boolean(pending)}
          onClick={() => {
            setOffset(view?.nextOffset ?? offset);
            setWorkspaceID("");
            reset();
          }}
        >
          More workspaces
        </button>
        <button
          type="button"
          disabled={busy || Boolean(pending) || !selected || view?.state !== "connected"}
          onClick={() => void inspect()}
        >
          Preview ownership change
        </button>
      </div>
      {preview ? (
        <div className={styles.preview}>
          <strong>
            {direction === "adopt"
              ? "Adopt this existing worktree"
              : "Release and keep this worktree"}
          </strong>
          <code>{preview.checkout.root}</code>
          <p>
            Retain {preview.affectedThreads.length} conversation
            {preview.affectedThreads.length === 1 ? "" : "s"} with original IDs. This action starts
            no agent, service or setup task.
          </p>
          <ul>
            {preview.affectedThreads.map((item) => (
              <li key={item.threadId}>{item.title || item.threadId}</li>
            ))}
          </ul>
          {preview.blockers.length ? (
            <ul role="status">
              {preview.blockers.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <button
              type="button"
              disabled={busy || Boolean(pending)}
              onClick={() => void confirm()}
            >
              {direction === "adopt" ? "Adopt worktree" : "Release lane and keep files"}
            </button>
          )}
        </div>
      ) : null}
      {record ? (
        <div className={styles.receipt} role="status">
          <strong>Ownership {record.state.replaceAll("_", " ")}</strong>
          <p>{record.detail}</p>
          <small>Receipt {record.id}</small>
          {pending ? (
            <button type="button" disabled={busy} onClick={() => void recover(record.id)}>
              Recover this receipt
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setRecord(null);
                reset();
                setWorkspaceID("");
              }}
            >
              Choose another ownership change
            </button>
          )}
        </div>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {records.length ? (
        <details>
          <summary>Saved ownership changes ({records.length})</summary>
          <ul className={styles.history}>
            {records.map((item) => (
              <li key={item.id}>
                <span>
                  {item.direction} · {item.state.replaceAll("_", " ")}
                </span>
                <button type="button" disabled={busy} onClick={() => void recover(item.id)}>
                  Open receipt
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
