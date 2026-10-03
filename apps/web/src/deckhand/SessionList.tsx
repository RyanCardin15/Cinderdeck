import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { buildThreadRouteParams } from "../threadRoutes";
import { managedSessionsView } from "./state";
import styles from "./workspace.module.css";
export function SessionList({
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
    managedSessionsView({
      environmentId,
      input: { installationID, workspaceID, generation, limit: 20 },
    }),
  );
  const sessions = Option.getOrNull(AsyncResult.value(result));
  const unavailable = result._tag === "Failure";
  return (
    <section className={styles["dh-session-list"]} aria-label="Managed agent sessions">
      <h3>Agent sessions</h3>
      {unavailable ? (
        <p role="status">
          Session state is unavailable. Open a conversation to inspect its saved history.
        </p>
      ) : !sessions ? (
        <p>Loading agent sessions…</p>
      ) : !sessions.length ? (
        <p>No managed sessions in this context yet.</p>
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
            {session.binding.providerInstanceId} · {session.binding.role}
            {session.archived ? " · Archived" : ""}
          </span>
          <span>
            {unavailable || session.source === "unavailable"
              ? "Unknown · Connection unavailable"
              : `${session.binding.execution.replaceAll("_", " ")} · ${session.binding.connection}`}
          </span>
        </Link>
      ))}
      {sessions?.length === 20 ? <p>Showing the 20 newest sessions in this context.</p> : null}
    </section>
  );
}
