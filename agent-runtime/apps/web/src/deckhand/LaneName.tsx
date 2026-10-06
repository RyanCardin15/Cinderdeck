import { useRef, useState } from "react";
import type { EnvironmentId } from "@cinderdeck/contracts";
import type { IntegrationView } from "@cinderdeck/contracts/deckhand/rpc";
import type { IntegrationOperationInput } from "@cinderdeck/contracts/deckhand/integration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { runtime } from "../lib/runtime";
import { useAtomCommand } from "../state/use-atom-command";
import { inspectOperation, recentOperations, submitOperation } from "./state";
import styles from "./laneName.module.css";

type Props = {
  environmentId: EnvironmentId;
  installationID: string;
  resource: IntegrationView["resources"][number];
  enabled: boolean;
};

/** Remount on checkout changes so a draft or saved request never targets another lane. */
export function LaneName(props: Props) {
  return (
    <LaneNameEditor
      key={`${props.environmentId}:${props.installationID}:${props.resource.workspaceID}:${props.resource.generation}`}
      {...props}
    />
  );
}

function LaneNameEditor({ environmentId, installationID, resource, enabled }: Props) {
  const name = resource.workspace?.lane?.name ?? resource.workspace?.name ?? "Lane";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [expectedName, setExpectedName] = useState(name);
  const [savedName, setSavedName] = useState<{ name: string; revision: string } | null>(null);
  const displayName = savedName?.revision === resource.revision ? savedName.name : name;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<IntegrationOperationInput | null>(null);
  const inFlight = useRef(false);
  const submit = useAtomCommand(submitOperation, { reportFailure: false });
  const inspect = useAtomCommand(inspectOperation, { reportFailure: false });
  const recent = useAtomCommand(recentOperations, { reportFailure: false });
  const ready = enabled && resource.available && !!resource.workspace?.lane;
  const cancel = () => {
    if (!inFlight.current && !pending.current) {
      setEditing(false);
      setError(null);
    }
  };
  const save = async () => {
    if (inFlight.current || !ready) return;
    const nextName = draft.trim();
    if (
      !pending.current &&
      (!nextName || [...nextName].length > 100 || /[\x00-\x1f\x7f-\x9f]/.test(nextName))
    ) {
      setError("Use 1–100 characters without control characters.");
      return;
    }
    if (!pending.current && nextName === expectedName) {
      setEditing(false);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const checking = pending.current;
      const input = checking ?? {
        operationKey: await runtime.runPromise(
          Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
        ),
        installationID,
        workspaceID: resource.workspaceID,
        generation: resource.generation,
        revision: resource.revision,
        method: "lane.update" as const,
        arguments: { workspace: resource.workspaceID, name: nextName, expectedName },
      };
      pending.current = input;
      const response = checking
        ? await inspect({
            environmentId,
            input: { operationKey: input.operationKey, waitMs: 25000 },
          })
        : await submit({ environmentId, input });
      if (response._tag !== "Success") {
        const records = await recent({ environmentId, input: {} });
        const refused =
          records._tag === "Success" &&
          records.value.find(
            (record) => record.input.operationKey === input.operationKey && record.refused,
          );
        if (refused) {
          pending.current = null;
          setError(
            "The lane changed or the rename was refused. Cancel and refresh before trying again.",
          );
          return;
        }
        setError("The reply was unavailable. Check the saved rename before trying again.");
        return;
      }
      const receipt = response.value;
      if (receipt.state === "succeeded") {
        pending.current = null;
        setSavedName({
          name: receipt.result?.workspace?.lane?.name ?? String(input.arguments.name),
          revision: resource.revision,
        });
        setEditing(false);
      } else if (receipt.state === "failed") {
        pending.current = null;
        setError(receipt.error?.message ?? "The rename failed. Refresh the lane and try again.");
      } else {
        setError("The rename is still unresolved. Check its saved result.");
      }
    } catch {
      setError("The reply was unavailable. Check the saved rename before trying again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <span className={styles.root}>
      {editing ? (
        <span className={styles.editor}>
          <input
            autoFocus
            aria-label="Lane name"
            value={draft}
            disabled={busy || !!pending.current}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                cancel();
              }
            }}
          />
          <button type="button" disabled={busy || !ready} onClick={() => void save()}>
            {busy ? "Saving…" : pending.current ? "Check rename" : "Save"}
          </button>
          <button type="button" disabled={busy || !!pending.current} onClick={cancel}>
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          className={styles.name}
          disabled={!ready}
          title="Click to rename lane"
          aria-label={`Rename lane ${displayName}`}
          onClick={() => {
            setDraft(displayName);
            setExpectedName(displayName);
            setError(null);
            setEditing(true);
          }}
        >
          {displayName}
        </button>
      )}
      {error ? (
        <span className={styles.error} role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
