import { ExternalSessionList } from "./ExternalSessionList";
import { useState } from "react";
import { BotIcon, ChevronRightIcon, MessagesSquareIcon, SearchIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { ThreadId, type EnvironmentId, type ProviderDriverKind } from "@cinderdeck/contracts";
import type { ManagedSessionView } from "@cinderdeck/contracts/deckhand/rpc";
import type { SessionBinding } from "@cinderdeck/contracts/deckhand";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { buildThreadRouteParams } from "../threadRoutes";
import { managedSessionsView, threadContextView } from "./state";
import { useEnvironmentQuery } from "../state/query";
import { useThreadShell } from "../state/entities";
import { useAgentObservation } from "./useAgentObservation";
import { agentExecutionLabel, agentProviderLabel } from "./agentPresentation";
import { useSessionActions } from "./useSessionActions";
import {
  ProviderInstanceIcon,
  providerTextColorClassName,
} from "../components/chat/ProviderInstanceIcon";
import { formatRelativeTimeLabel } from "../timestampFormat";
import styles from "./sessions.module.css";
type SessionProvider = {
  readonly instanceId: string;
  readonly displayName: string;
  readonly driverKind?: ProviderDriverKind;
  readonly accentColor?: string | undefined;
  readonly acpRegistryAgentId?: string | undefined;
  readonly acpRegistryIconUrl?: string | undefined;
};
const EMPTY_PROVIDERS: ReadonlyArray<SessionProvider> = [];
const connectionLabels: Record<SessionBinding["connection"], string> = {
  connected: "Agent connected",
  reconnecting: "Agent connecting",
  unavailable: "Agent not connected",
  stale: "Agent not connected",
};
const sessionPurpose = (binding: SessionBinding) =>
  binding.role === "writer"
    ? "Implementation"
    : binding.role === "reviewer"
      ? "Review"
      : binding.desiredAccess === "read_only" && binding.capabilities.enforcedReadOnly
        ? "Analysis · read only"
        : "Observer";
function SessionAvatar({ provider }: { provider: SessionProvider | undefined }) {
  return (
    <span className={styles.sessionIcon} aria-hidden>
      {provider?.driverKind ? (
        <ProviderInstanceIcon
          driverKind={provider.driverKind}
          displayName={provider.displayName}
          accentColor={provider.accentColor}
          acpRegistryAgentId={provider.acpRegistryAgentId}
          acpRegistryIconUrl={provider.acpRegistryIconUrl}
          className={`${styles.providerGlyph ?? ""} ${providerTextColorClassName(provider.driverKind) ?? ""}`}
          iconClassName={styles.providerGlyphIcon ?? ""}
        />
      ) : (
        <BotIcon size={16} />
      )}
      <i className={styles.statusDot} />
    </span>
  );
}
/** Reads the thread's last activity from the client shell when it is loaded. */
function SessionAge({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const shell = useThreadShell({ environmentId, threadId });
  const label = shell?.updatedAt ? formatRelativeTimeLabel(shell.updatedAt) : "";
  return label ? (
    <>
      {" · "}
      <time className={styles.sessionAge} dateTime={shell!.updatedAt}>
        {label}
      </time>
    </>
  ) : null;
}
type SessionListProps = {
  environmentId: EnvironmentId;
  installationID: string;
  workspaceID: string;
  generation: number;
  scope?: "context" | "workspace";
  providers?: ReadonlyArray<SessionProvider>;
  contextLabel?: string;
  selectedThreadId?: string;
  showExternal?: boolean;
  compact?: boolean;
  presentation?: "default" | "workspace";
};
export function SessionList(props: SessionListProps) {
  return (
    <ScopedSessionList
      key={`${props.environmentId}:${props.installationID}:${props.workspaceID}:${props.generation}:${props.scope ?? "context"}`}
      {...props}
    />
  );
}
function ScopedSessionList({
  environmentId,
  installationID,
  workspaceID,
  generation,
  scope = "context",
  providers = EMPTY_PROVIDERS,
  contextLabel = "Selected checkout",
  selectedThreadId,
  showExternal = true,
  compact = false,
  presentation = "default",
}: SessionListProps) {
  const workspacePresentation = presentation === "workspace" && !compact;
  const { showMenu, renameDialog } = useSessionActions(environmentId);
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
        ...(scope === "workspace" ? { scope } : {}),
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
  const selectedOnPage = sessions?.find((session) => session.binding.threadId === selectedThreadId);
  const selectedRef =
    selectedThreadId && !selectedOnPage
      ? { environmentId, threadId: ThreadId.make(selectedThreadId) }
      : null;
  const selectedQuery = useEnvironmentQuery(
    selectedRef
      ? threadContextView({
          environmentId,
          input: { threadId: selectedRef.threadId },
        })
      : null,
  );
  const selectedContext = selectedQuery.data;
  const selectedShell = useThreadShell(selectedRef);
  const selectedObservation = useAgentObservation(
    environmentId,
    `${installationID}:${workspaceID}:${generation}:${selectedThreadId ?? ""}:selected`,
    selectedContext,
  );
  const selectedContextMatchesScope =
    selectedContext !== null &&
    selectedContext.workspace.environmentId === installationID &&
    (scope === "workspace"
      ? selectedContext.workspace.ownerId === workspaceID
      : (selectedContext.checkout.laneId ?? selectedContext.workspace.ownerId) === workspaceID &&
        selectedContext.checkout.nativeGeneration === generation);
  const selectedMatchesScope =
    selectedContextMatchesScope &&
    selectedContext?.session.threadId === selectedThreadId &&
    (selectedContext?.requestedThreadId ?? selectedContext?.session.threadId) === selectedThreadId;
  const selectedIsHelper =
    selectedContextMatchesScope &&
    selectedContext?.requestedThreadId === selectedThreadId &&
    selectedContext?.session.threadId !== selectedThreadId;
  const exactSelected: ManagedSessionView | null =
    selectedMatchesScope && selectedContext
      ? {
          binding: selectedContext.session,
          title: selectedShell?.title || selectedContext.feature.title,
          source: selectedContext.session.execution === "unknown" ? "unavailable" : "current",
          archived: Boolean(selectedShell?.archivedAt || selectedShell?.deletedAt),
        }
      : null;
  const pagingUnavailable =
    page.offset > 0 &&
    sessions !== null &&
    sessions.length > 0 &&
    sessions.length === page.previousIDs.length &&
    sessions.every((session, index) => session.binding.id === page.previousIDs[index]);
  const groupFor = (session: NonNullable<typeof sessions>[number]) => {
    if (scope === "workspace" && session.context?.availability === "removed") return "history";
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
    ...(scope === "workspace" ? [{ id: "history", label: "Past checkouts" }] : []),
  ];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const searchMatches = (sessions ?? []).filter(
    (session) =>
      (providerFilter === "all" || session.binding.providerInstanceId === providerFilter) &&
      (!normalizedQuery ||
        [
          session.title,
          session.context?.label,
          contextLabel,
          agentProviderLabel(session.binding.providerInstanceId, providers),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedQuery)),
  );
  const filtered = searchMatches.filter(
    (session) => statusFilter === "all" || groupFor(session) === statusFilter,
  );
  const statusCount = (id: string) =>
    id === "all"
      ? searchMatches.length
      : searchMatches.filter((session) => groupFor(session) === id).length;
  const pageProviders = Array.from(
    new Set(sessions?.map((s) => s.binding.providerInstanceId) ?? []),
  );
  const hasFilters = query !== "" || statusFilter !== "all" || providerFilter !== "all";
  const rangeOffset = pagingUnavailable ? Math.max(0, page.offset - 20) : page.offset;
  const sessionRow = (
    session: ManagedSessionView,
    rowStale = observation.stale,
    rowUnavailable = unavailable,
  ) => {
    const notConnected = rowStale || rowUnavailable || session.source === "unavailable";
    const execution = rowStale
      ? "Last observed"
      : notConnected
        ? "Unknown"
        : session.binding.connection === "stale"
          ? "Last observed"
          : agentExecutionLabel(session.binding.execution);
    const connected = !notConnected && session.binding.connection === "connected";
    const tone = !connected
      ? "other"
      : session.binding.execution === "failed"
        ? "failed"
        : groupFor(session);
    return (
      <Link
        key={session.binding.id}
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams({
          environmentId,
          threadId: session.binding.threadId,
        })}
        aria-current={selectedThreadId === session.binding.threadId ? "page" : undefined}
        className={styles.session}
        data-tone={tone}
        onContextMenu={(event) => {
          event.preventDefault();
          void showMenu(
            session,
            { x: event.clientX, y: event.clientY },
            !rowStale && !rowUnavailable,
          );
        }}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          void showMenu(
            session,
            { x: bounds.left, y: bounds.bottom },
            !rowStale && !rowUnavailable,
          );
        }}
      >
        <SessionAvatar
          provider={providers.find(
            (provider) => provider.instanceId === session.binding.providerInstanceId,
          )}
        />
        <div className={styles.sessionIdentity}>
          <strong>{session.title}</strong>
          <span className={styles.provider}>
            {agentProviderLabel(session.binding.providerInstanceId, providers)}
            {` · ${sessionPurpose(session.binding)}${session.archived ? " · Archived" : ""}`}
            <SessionAge environmentId={environmentId} threadId={session.binding.threadId} />
          </span>
          {scope === "workspace" && session.context ? (
            <span className={styles.checkoutLabel}>
              <span>{session.context.label}</span>
              {session.context.availability === "removed" ? (
                <em>Checkout removed · chat saved</em>
              ) : null}
            </span>
          ) : null}
        </div>
        <span className={styles.sessionStatus}>
          <span className={styles.statusLabel}>{execution}</span>
          <span className={connected ? styles.srOnly : styles.connectionNote}>
            <span className={styles.srOnly}> · </span>
            {notConnected ? "Agent not connected" : connectionLabels[session.binding.connection]}
          </span>
        </span>
        {workspacePresentation ? (
          <ChevronRightIcon className={styles.rowArrow} size={16} aria-hidden />
        ) : null}
      </Link>
    );
  };
  const selectedOutsideFilters =
    selectedOnPage && !filtered.some((session) => session.binding.id === selectedOnPage.binding.id);
  const selectedOutsidePage = selectedThreadId && !selectedOnPage;
  const retainedSelected = selectedOutsideFilters
    ? selectedOnPage
    : selectedOutsidePage
      ? exactSelected
      : null;
  const statusTabs = (
    <div className={styles.statusTabs} role="group" aria-label="Filter by status">
      {[{ id: "all", label: "All" }, ...groups].map(({ id, label }) => {
        const count = statusCount(id);
        if (id !== "all" && id !== statusFilter && !count) return null;
        return (
          <button
            type="button"
            key={id}
            className={styles.statusTab}
            data-status={id}
            aria-pressed={statusFilter === id}
            onClick={() => setStatusFilter(id)}
          >
            {id === "all" ? null : <i aria-hidden />}
            {label}
            <span>{count}</span>
          </button>
        );
      })}
    </div>
  );
  const filterControls = (
    <>
      {workspacePresentation && sessions?.length ? statusTabs : null}
      <div className={styles.filters}>
        <label className={styles.search}>
          <span className={styles.srOnly}>Search sessions on this page</span>
          {workspacePresentation ? <SearchIcon size={15} aria-hidden /> : null}
          <input
            type="search"
            placeholder={
              workspacePresentation
                ? "Search conversations on this page…"
                : "Find a session on this page…"
            }
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {workspacePresentation ? null : (
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
        )}
        {workspacePresentation && pageProviders.length < 2 && providerFilter === "all" ? null : (
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
        )}
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
        {workspacePresentation
          ? "Search and filters apply to this page. Helpers stay in their parent conversation."
          : "Filters apply to this fetched page. Helpers stay in their parent conversation."}
      </p>
    </>
  );
  return (
    <>
      {renameDialog}
      <section
        className={`${styles.roster} ${compact ? styles.compact : workspacePresentation ? styles.workspaceRoster : ""}`}
        aria-label="Managed agent sessions"
      >
        <header className={styles.rosterHeading}>
          <div>
            <h3>{workspacePresentation ? "Conversations" : "Sessions"}</h3>
            {!compact && !workspacePresentation ? (
              <p>{contextLabel} · independent conversations</p>
            ) : null}
          </div>
          {sessions ? (
            <span className={styles.count}>
              {observation.stale || unavailable ? "Last observed · " : ""}
              {filtered.length} on this page
            </span>
          ) : null}
        </header>
        {scope === "workspace" ? (
          <p className={styles.scopeNote}>
            All lanes, including saved chats from removed checkouts.
          </p>
        ) : null}
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
          <div className={styles.empty}>
            {workspacePresentation ? <MessagesSquareIcon size={28} aria-hidden /> : null}
            {workspacePresentation && !page.offset ? (
              <h4>Your next conversation starts here</h4>
            ) : null}
            <p>
              {page.offset
                ? "No older sessions on this page. Return to the previous page."
                : workspacePresentation
                  ? scope === "workspace"
                    ? "No conversations in this workspace yet. Open a new chat to get started."
                    : "No conversations in this checkout yet. Open a new chat to get started."
                  : "No managed sessions in this context yet."}
            </p>
          </div>
        ) : null}
        {sessions?.length && !filtered.length ? (
          <p className={styles.empty}>
            No sessions match these filters on this page. Clear filters or check another page.
          </p>
        ) : null}
        {retainedSelected ? (
          <section className={styles.group} aria-label="Current session">
            <h4>
              Current session ·{" "}
              {selectedOutsideFilters ? "outside these filters" : "outside this page"}
            </h4>
            {sessionRow(
              retainedSelected,
              selectedOutsideFilters ? observation.stale : selectedObservation.stale,
              selectedOutsideFilters
                ? unavailable
                : !selectedQuery.isSuccess || selectedQuery.error !== null,
            )}
          </section>
        ) : selectedOutsidePage && !selectedIsHelper ? (
          <p className={styles.notice} role="status">
            {selectedQuery.isPending && !selectedContext
              ? "Loading the current session…"
              : "The current session could not be confirmed in this context. Its conversation remains open."}
          </p>
        ) : null}
        {groups.map((group) => {
          const rows = filtered.filter((session) => groupFor(session) === group.id);
          return rows.length ? (
            <details
              className={`${styles.group} ${styles.sessionGroup}`}
              key={group.id}
              data-group={group.id}
              aria-label={group.label}
              open={
                group.id === "attention" ||
                group.id === "active" ||
                group.id === "other" ||
                (scope === "workspace" && group.id !== "history") ||
                (hasFilters && scope === "workspace") ||
                rows.some((session) => session.binding.threadId === selectedThreadId)
              }
            >
              <summary>
                <ChevronRightIcon size={13} aria-hidden />
                <h4>
                  {observation.stale || unavailable ? "Last observed · " : ""}
                  {group.label} <span>{rows.length}</span>
                </h4>
              </summary>
              <div className={styles.groupRows}>{rows.map((session) => sessionRow(session))}</div>
            </details>
          ) : null;
        })}
        {pagingUnavailable ? (
          <p role="status" className={styles.notice}>
            Older-session paging could not be confirmed. The previous page is retained.
          </p>
        ) : sessions?.length ? (
          <p className={styles.scopeNote}>
            {observation.stale || unavailable ? "Last observed sessions" : "Sessions"}{" "}
            {rangeOffset + 1}–{rangeOffset + sessions.length} in this{" "}
            {scope === "workspace" ? "workspace" : "context"}.
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
          presentation={presentation}
        />
      ) : null}
    </>
  );
}
