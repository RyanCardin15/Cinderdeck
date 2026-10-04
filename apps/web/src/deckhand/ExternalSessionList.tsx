import { EXTERNAL_SESSION_METHODS } from "@t3tools/contracts/deckhand/externalSessionsRpc";
import type { EnvironmentId } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { useAgentObservation } from "./useAgentObservation";
import styles from "./workspace.module.css";
export const externalSessionsView = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "deckhand:external-sessions",
  tag: EXTERNAL_SESSION_METHODS.list,
  staleTimeMs: 15000,
  refreshIntervalMs: 15000,
  // A departed inspector must release its read, rather than queue old native
  // context refreshes behind the currently selected lane.
  idleTtlMs: 0,
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
  const result = useAtomValue(
    externalSessionsView({
      environmentId,
      input: { installationID, workspaceID, generation, limit: 20 },
    }),
  );
  const sessions = Option.getOrNull(AsyncResult.value(result));
  const unavailable = result._tag === "Failure";
  const observation = useAgentObservation(
    environmentId,
    `${installationID}:${workspaceID}:${generation}`,
    sessions,
  );
  return (
    <section className={styles["dh-session-list"]} aria-label="Reported external sessions">
      <h3>External sessions</h3>
      <p>
        Agents registered by other apps appear here. Their status comes from that app; open it to
        control them.
      </p>
      {unavailable ? (
        <p role="status">
          External session state is unavailable. Retained rows show only the last observed report.
        </p>
      ) : observation.stale ? (
        <p role="status">
          {observation.reconnecting ? "Reconnecting." : "Connection unavailable."} External
          registrations show only the last observed report.
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
            {unavailable || observation.stale
              ? "Last observed · Connection unavailable"
              : session.connection === "stale"
                ? "Last observed · Agent not connected"
                : "Agent connected"}
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
