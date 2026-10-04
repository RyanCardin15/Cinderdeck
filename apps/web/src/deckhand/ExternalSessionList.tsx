import {
  EXTERNAL_SESSION_METHODS,
  type ExternalSessionView,
} from "@t3tools/contracts/deckhand/externalSessionsRpc";
import type { EnvironmentId } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "../state/use-atom-command";
import styles from "./workspace.module.css";
export const externalSessionsList = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:external-sessions",
  tag: EXTERNAL_SESSION_METHODS.list,
});
export function ExternalSessionList(props: {
  environmentId: EnvironmentId;
  installationID: string;
  workspaceID: string;
  generation: number;
}) {
  return (
    <ScopedExternalSessionList
      key={`${props.environmentId}:${props.installationID}:${props.workspaceID}:${props.generation}`}
      {...props}
    />
  );
}
function ScopedExternalSessionList({
  environmentId,
  installationID,
  workspaceID,
  generation,
}: {
  environmentId: EnvironmentId;
  installationID: string;
  workspaceID: string;
  generation: number;
}) {
  const list = useAtomCommand(externalSessionsList, { reportFailure: false });
  const [sessions, setSessions] = useState<ReadonlyArray<ExternalSessionView> | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let disposed = false;
    let running = false;
    const load = async () => {
      if (running || disposed) return;
      running = true;
      try {
        const response = await list({
          environmentId,
          input: { installationID, workspaceID, generation, limit: 20 },
        });
        if (disposed) return;
        setUnavailable(response._tag !== "Success");
        if (response._tag === "Success") setSessions(response.value);
      } finally {
        running = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
    // The outer component remounts this scoped subscription for every identity/generation change.
  }, []);
  return (
    <section className={styles["dh-session-list"]} aria-label="Reported external sessions">
      <h3>External sessions</h3>
      <p>
        Registrant-reported visibility. Provider status is unverified; process controls are
        unavailable.
      </p>
      {unavailable ? (
        <p role="status">
          External session state is unavailable. Retained rows show only the last observed report.
        </p>
      ) : sessions === null ? (
        <p>Loading external sessions…</p>
      ) : !sessions.length ? (
        <p>No registered external sessions in this context.</p>
      ) : null}
      {sessions?.map((session) => (
        <article key={session.id} className={styles["dh-session-row"]}>
          <strong>{session.title}</strong>
          <span>
            {session.providerName} · Reported {session.role}
          </span>
          <span>
            Last reported: {session.reportedExecution.replaceAll("_", " ")} ·{" "}
            {unavailable || session.connection === "stale"
              ? "Connection lost / last seen"
              : "Registration connected"}
          </span>
          <span>Last seen {session.lastSeenAt}</span>
          <details>
            <summary>Registration details</summary>
            <p>
              {session.id} · {session.providerSessionId}
            </p>
            <p>
              Reported capabilities:{" "}
              {session.reportedCapabilities.length
                ? session.reportedCapabilities.join(", ").replaceAll("_", " ")
                : "None"}
              . These do not grant Deckhand controls or enforce read-only execution.
            </p>
          </details>
          <span>No transcript, stop/resume, approvals or writer reservation.</span>
        </article>
      ))}
      {sessions?.length === 20 ? <p>Showing the 20 newest registrations in this context.</p> : null}
    </section>
  );
}
