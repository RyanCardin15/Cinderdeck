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
import styles from "./sessions.module.css";
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
  contextLabel?: string;
  selectedThreadId?: string;
  showExternal?: boolean;
  compact?: boolean;
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
  contextLabel = "Selected checkout",
  selectedThreadId,
  showExternal = true,
  compact = false,
}: SessionListProps) {
  const [page, setPage] = useState<{ offset: number; previousIDs: ReadonlyArray<string> }>({
    offset: 0,
    previousIDs: [],
  });
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [providerFilter, setProviderFilter] = useState("all");
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
  const groupFor = (session: NonNullable<typeof sessions>[number]) => {
    if (session.archived) return "other";
    if (session.source === "unavailable" || session.binding.execution === "unknown") return "other";
    if (["waiting_input", "waiting_approval", "failed"].includes(session.binding.execution))
      return "attention";
    if (["queued", "starting", "working"].includes(session.binding.execution)) return "active";
    return session.binding.execution === "finished_turn" ? "completed" : "other";
  };
  const groups = [
    { id: "attention", label: "Needs attention" },
    { id: "active", label: "In progress" },
    { id: "completed", label: "Completed turns" },
    { id: "other", label: "Other sessions" },
  ];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = (sessions ?? []).filter(
    (session) =>
      (statusFilter === "all" || groupFor(session) === statusFilter) &&
      (providerFilter === "all" || session.binding.providerInstanceId === providerFilter) &&
      (!normalizedQuery ||
        [
          session.title,
          contextLabel,
          agentProviderLabel(session.binding.providerInstanceId, providers),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedQuery)),
  );
  const pageProviders = Array.from(
    new Set(sessions?.map((s) => s.binding.providerInstanceId) ?? []),
  );
  const hasFilters = query !== "" || statusFilter !== "all" || providerFilter !== "all";
  const rangeOffset = pagingUnavailable ? Math.max(0, page.offset - 20) : page.offset;
  const filterControls = (
    <>
      <div className={styles.filters}>
        <label className={styles.search}>
          <span className={styles.srOnly}>Search sessions on this page</span>
          <input
            type="search"
            placeholder="Find a session on this page…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <span>Status</span>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">All statuses</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Provider</span>
          <select
            value={providerFilter}
            onChange={(event) => setProviderFilter(event.target.value)}
          >
            <option value="all">All providers on this page</option>
            {pageProviders.map((id) => (
              <option key={id} value={id}>
                {agentProviderLabel(id, providers)}
              </option>
            ))}
          </select>
        </label>
        {hasFilters ? (
          <button
            type="button"
            className={styles.quiet}
            onClick={() => {
              setQuery("");
              setStatusFilter("all");
              setProviderFilter("all");
            }}
          >
            Clear filters
          </button>
        ) : null}
      </div>
      <p className={styles.scopeNote}>
        Filters apply to this fetched page. Helpers stay in their parent conversation.
      </p>
    </>
  );
  return (
    <>
      <section
        className={compact ? `${styles.roster} ${styles.compact}` : styles.roster}
        aria-label="Managed agent sessions"
      >
        <header className={styles.rosterHeading}>
          <div>
            <h3>Sessions</h3>
            {!compact ? <p>{contextLabel} · independent conversations</p> : null}
          </div>
          {sessions ? (
            <span className={styles.count}>
              {observation.stale || unavailable ? "Last observed · " : ""}
              {filtered.length} on this page
            </span>
          ) : null}
        </header>
        {compact ? (
          <details className={styles.filterFold}>
            <summary>Filter{hasFilters ? " · active" : ""}</summary>
            {filterControls}
          </details>
        ) : (
          filterControls
        )}
        {unavailable ? (
          <p role="status" className={styles.notice}>
            Session state is unavailable. Open a conversation to inspect its saved history.
          </p>
        ) : observation.stale ? (
          <p role="status" className={styles.notice}>
            {observation.reconnecting ? "Reconnecting." : "Connection unavailable."} Sessions show
            only the last observed state.
          </p>
        ) : !sessions ? (
          <p className={styles.empty}>Loading sessions…</p>
        ) : !sessions.length ? (
          <p className={styles.empty}>
            {page.offset
              ? "No older sessions on this page. Return to the previous page."
              : "No managed sessions in this context yet."}
          </p>
        ) : null}
        {sessions?.length && !filtered.length ? (
          <p className={styles.empty}>
            No sessions match these filters on this page. Clear filters or check another page.
          </p>
        ) : null}
        {groups.map((group) => {
          const rows = filtered.filter((session) => groupFor(session) === group.id);
          return rows.length ? (
            <section className={styles.group} key={group.id} aria-label={group.label}>
              <h4>
                {observation.stale || unavailable ? "Last observed · " : ""}
                {group.label} <span>{rows.length}</span>
              </h4>
              {rows.map((session) => (
                <Link
                  key={session.binding.id}
                  to="/$environmentId/$threadId"
                  params={buildThreadRouteParams({
                    environmentId,
                    threadId: session.binding.threadId,
                  })}
                  aria-current={selectedThreadId === session.binding.threadId ? "page" : undefined}
                  className={styles.session}
                >
                  <div className={styles.sessionIdentity}>
                    <span className={styles.provider}>
                      {agentProviderLabel(session.binding.providerInstanceId, providers)}
                    </span>
                    <strong>{session.title}</strong>
                    <span className={styles.sessionScope}>
                      {contextLabel} ·{" "}
                      {session.binding.role === "writer"
                        ? "Implementation"
                        : session.binding.role === "reviewer"
                          ? "Review"
                          : session.binding.desiredAccess === "read_only" &&
                              session.binding.capabilities.enforcedReadOnly
                            ? "Analysis · read only"
                            : "Observer"}
                      {session.archived ? " · Archived" : ""}
                    </span>
                  </div>
                  <span className={styles.sessionStatus}>
                    {observation.stale
                      ? "Last observed · Agent not connected"
                      : unavailable || session.source === "unavailable"
                        ? "Unknown · Agent not connected"
                        : `${session.binding.connection === "stale" ? "Last observed" : agentExecutionLabel(session.binding.execution)} · ${connectionLabels[session.binding.connection]}`}
                  </span>
                </Link>
              ))}
            </section>
          ) : null;
        })}
        {pagingUnavailable ? (
          <p role="status" className={styles.notice}>
            Older-session paging could not be confirmed. The previous page is retained.
          </p>
        ) : sessions?.length ? (
          <p className={styles.scopeNote}>
            {observation.stale || unavailable ? "Last observed sessions" : "Sessions"}{" "}
            {rangeOffset + 1}–{rangeOffset + sessions.length} in this context.
          </p>
        ) : null}
        {page.offset || sessions?.length === 20 ? (
          <nav aria-label="Managed session pages" className={styles.pages}>
            <button
              type="button"
              className={styles.quiet}
              disabled={!page.offset}
              onClick={() => setPage({ offset: Math.max(0, page.offset - 20), previousIDs: [] })}
            >
              Previous sessions
            </button>
            <button
              type="button"
              className={styles.quiet}
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
              Next sessions
            </button>
          </nav>
        ) : null}
        {page.offset >= 10000 ? (
          <p className={styles.scopeNote}>
            The bounded older-session history limit has been reached.
          </p>
        ) : null}
      </section>
      {showExternal ? (
        <ExternalSessionList
          environmentId={environmentId}
          installationID={installationID}
          workspaceID={workspaceID}
          generation={generation}
        />
      ) : null}
    </>
  );
}
