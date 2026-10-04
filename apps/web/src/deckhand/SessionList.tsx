import { ExternalSessionList } from "./ExternalSessionList";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SessionBinding } from "@t3tools/contracts/deckhand";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { buildThreadRouteParams } from "../threadRoutes";
import { managedSessionsView } from "./state";
import { useAgentObservation } from "./useAgentObservation";
import { agentExecutionLabel, agentProviderLabel } from "./agentPresentation";
import styles from "./workspace.module.css";
const EMPTY_PROVIDERS: ReadonlyArray<{
  readonly instanceId: string;
  readonly displayName: string;
}> = [];
const connectionLabels: Record<SessionBinding["connection"], string> = {
  connected: "Agent connected",
  reconnecting: "Agent connecting",
  unavailable: "Agent not connected",
  stale: "Agent not connected",
};
type SessionListProps = {
  environmentId: EnvironmentId;
  installationID: string;
  workspaceID: string;
  generation: number;
  providers?: ReadonlyArray<{ readonly instanceId: string; readonly displayName: string }>;
};
export function SessionList(props: SessionListProps) {
  return (
    <ScopedSessionList
      key={`${props.environmentId}:${props.installationID}:${props.workspaceID}:${props.generation}`}
      {...props}
    />
  );
}
function ScopedSessionList({
  environmentId,
  installationID,
  workspaceID,
  generation,
  providers = EMPTY_PROVIDERS,
}: SessionListProps) {
  const [page, setPage] = useState<{ offset: number; previousIDs: ReadonlyArray<string> }>({
    offset: 0,
    previousIDs: [],
  });
  const result = useAtomValue(
    managedSessionsView({
      environmentId,
      input: {
        installationID,
        workspaceID,
        generation,
        limit: 20,
        ...(page.offset ? { offset: page.offset } : {}),
      },
    }),
  );
  const sessions = Option.getOrNull(AsyncResult.value(result));
  const unavailable = result._tag === "Failure";
  const observation = useAgentObservation(
    environmentId,
    `${installationID}:${workspaceID}:${generation}:${page.offset}`,
    sessions,
  );
  const pagingUnavailable =
    page.offset > 0 &&
    sessions !== null &&
    sessions.length > 0 &&
    sessions.length === page.previousIDs.length &&
    sessions.every((session, index) => session.binding.id === page.previousIDs[index]);
  return (
    <>
      <section className={styles["dh-session-list"]} aria-label="Managed agent sessions">
        <h3>Agent sessions</h3>
        {unavailable ? (
          <p role="status">
            Session state is unavailable. Open a conversation to inspect its saved history.
          </p>
        ) : observation.stale ? (
          <p role="status">
            {observation.reconnecting ? "Reconnecting." : "Connection unavailable."} Agent sessions
            show only the last observed state.
          </p>
        ) : !sessions ? (
          <p>Loading agent sessions…</p>
        ) : !sessions.length ? (
          <p>
            {page.offset
              ? "No older agents on this page. Return to the previous page to inspect this lane’s sessions."
              : "No managed sessions in this context yet."}
          </p>
        ) : null}
        {sessions?.map((session) => (
          <Link
            key={session.binding.id}
            to="/$environmentId/$threadId"
            params={buildThreadRouteParams({ environmentId, threadId: session.binding.threadId })}
            className={styles["dh-session-row"]}
          >
            <strong>{session.title}</strong>
            <span>
              {agentProviderLabel(session.binding.providerInstanceId, providers)} ·{" "}
              {session.binding.role}
              {session.archived ? " · Archived" : ""}
            </span>
            <span>
              {observation.stale
                ? "Last observed · Connection unavailable"
                : unavailable || session.source === "unavailable"
                  ? "Unknown · Agent not connected"
                  : `${session.binding.connection === "stale" ? "Last observed" : agentExecutionLabel(session.binding.execution)} · ${connectionLabels[session.binding.connection]}`}
            </span>
          </Link>
        ))}
        {pagingUnavailable ? (
          <p role="status">
            Older-agent paging could not be confirmed. The previous page is retained.
          </p>
        ) : sessions?.length ? (
          <p>
            {observation.stale || unavailable ? "Last observed sessions" : "Sessions"}{" "}
            {page.offset + 1}–{page.offset + sessions.length} in this context.
          </p>
        ) : null}
        {page.offset || sessions?.length === 20 ? (
          <nav aria-label="Managed session pages" className={styles["dh-inspector-actions"]}>
            <button
              type="button"
              className={styles["dh-button"]}
              disabled={!page.offset}
              onClick={() => setPage({ offset: Math.max(0, page.offset - 20), previousIDs: [] })}
            >
              Previous agents
            </button>
            <button
              type="button"
              className={styles["dh-button"]}
              disabled={
                !sessions ||
                sessions.length < 20 ||
                page.offset >= 10000 ||
                unavailable ||
                observation.stale ||
                pagingUnavailable
              }
              onClick={() =>
                setPage({
                  offset: page.offset + 20,
                  previousIDs: sessions?.map((session) => session.binding.id) ?? [],
                })
              }
            >
              Next agents
            </button>
          </nav>
        ) : null}
        {page.offset >= 10000 ? (
          <p>The bounded older-session history limit has been reached.</p>
        ) : null}
      </section>
      <ExternalSessionList
        environmentId={environmentId}
        installationID={installationID}
        workspaceID={workspaceID}
        generation={generation}
      />
    </>
  );
}
