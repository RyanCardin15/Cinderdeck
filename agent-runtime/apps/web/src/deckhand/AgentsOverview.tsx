import { useEffect, useId, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import type { EnvironmentId } from "@cinderdeck/contracts";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  SearchIcon,
  ArrowRightIcon,
} from "lucide-react";
import {
  useProjects,
  useThreadShells,
  useAllEnvironmentShellsBootstrapped,
} from "../state/entities";
import { useEnvironments, type EnvironmentPresentation } from "../state/environments";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { ProductNavigation } from "./ProductNavigation";
import { workspaceView } from "./state";
import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import {
  presentThreadShell,
  scopeProject,
  type EnvironmentThreadShell,
  type EnvironmentProject,
} from "@cinderdeck/client-runtime/state/models";
import { ExternalSessionList } from "./ExternalSessionList";
import {
  groupWorkspaceAgents,
  agentNeedsAttention,
  agentStatus,
  type AgentResource,
  type AgentWorkspaceGroup,
} from "./agentWorkspaceGroups";
import styles from "./agentsOverview.module.css";

export function AgentsOverview() {
  const { environments } = useEnvironments();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [archived, setArchived] = useState(false);
  const currentThreads = useThreadShells();
  const currentProjects = useProjects();
  const archive = useArchivedThreadSnapshots(
    archived ? environments.map((environment) => environment.environmentId) : [],
  );
  const threads = [
    ...new Map(
      [
        ...archive.snapshots.flatMap(({ environmentId, snapshot }) =>
          snapshot.threads.map((thread) => presentThreadShell(environmentId, thread)),
        ),
        ...currentThreads,
      ].map((thread) => [`${thread.environmentId}:${thread.id}`, thread]),
    ).values(),
  ];
  const projects = [
    ...new Map(
      [
        ...archive.snapshots.flatMap(({ environmentId, snapshot }) =>
          snapshot.projects.map((project) => scopeProject(environmentId, project)),
        ),
        ...currentProjects,
      ].map((project) => [`${project.environmentId}:${project.id}`, project]),
    ).values(),
  ];
  const ready = useAllEnvironmentShellsBootstrapped();
  const visible = threads.filter((thread) => !thread.deletedAt && (archived || !thread.archivedAt));
  const attentionCount = visible.filter(agentNeedsAttention).length;
  return (
    <div className={styles.shell}>
      <ProductNavigation current="conversations" />
      <main className={styles.main}>
        <header className={styles.heading}>
          <div>
            <span className={styles.eyebrow}>Across your workspaces</span>
            <h1>Agents</h1>
            <p>Every workspace, every conversation. Pick up where your agents left off.</p>
          </div>
          <Link to="/inbox" className={styles.attentionLink}>
            {attentionCount} {attentionCount === 1 ? "needs attention" : "need attention"}{" "}
            <ArrowRightIcon size={15} />
          </Link>
        </header>
        <div className={styles.toolbar}>
          <label className={styles.search}>
            <SearchIcon size={16} />
            <input
              type="search"
              aria-label="Search workspaces and agents"
              placeholder="Search workspaces and agents…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <select
            aria-label="Agent status"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">All agents</option>
            <option value="attention">Needs attention</option>
            <option value="working">Working</option>
          </select>
          <label>
            <input
              type="checkbox"
              checked={archived}
              onChange={(event) => setArchived(event.target.checked)}
            />{" "}
            Include archived
          </label>
        </div>
        {!ready ? (
          <p role="status" className={styles.notice}>
            Synchronizing agents… Saved status may be out of date.
          </p>
        ) : null}
        {archived && (archive.error || archive.isLoading) ? (
          <p role="status" className={styles.notice}>
            {archive.error ?? "Loading archived agents…"}
          </p>
        ) : null}
        {environments.map((environment) => (
          <ComputerAgents
            key={environment.environmentId}
            environment={environment}
            query={query}
            filter={filter}
            archived={archived}
            allThreads={threads}
            allProjects={projects}
          />
        ))}
        {!environments.length ? (
          <div className={styles.empty}>
            <BotIcon size={30} />
            <h2>Connect your work</h2>
            <Link to="/settings/connections">Manage connections</Link>
          </div>
        ) : null}
      </main>
    </div>
  );
}
function ComputerAgents({
  environment,
  query,
  filter,
  archived,
  allThreads,
  allProjects,
}: {
  environment: EnvironmentPresentation;
  query: string;
  filter: string;
  archived: boolean;
  allThreads: readonly EnvironmentThreadShell[];
  allProjects: readonly EnvironmentProject[];
}) {
  const [offset, setOffset] = useState(0);
  const [catalog, setCatalog] = useState<Record<number, readonly AgentResource[]>>({});
  const result = useAtomValue(
    workspaceView({ environmentId: environment.environmentId, input: { offset, limit: 100 } }),
  );
  const view = Option.getOrNull(AsyncResult.value(result));
  const installation = view?.hello?.installationID;
  useEffect(() => {
    setCatalog({});
    setOffset(0);
  }, [installation]);
  useEffect(() => {
    if (view) setCatalog((previous) => ({ ...previous, [offset]: view.resources }));
  }, [view, offset]);
  const resources = [
    ...new Map(
      [...Object.values(catalog).flat(), ...(view?.resources ?? [])].map((resource) => [
        resource.workspaceID,
        resource,
      ]),
    ).values(),
  ];
  const projects = allProjects.filter(
    (project) => project.environmentId === environment.environmentId,
  );
  const threads = allThreads.filter(
    (thread) =>
      thread.environmentId === environment.environmentId &&
      !thread.deletedAt &&
      (archived || !thread.archivedAt),
  );
  const groups = groupWorkspaceAgents(resources, projects, threads);
  const connected = environment.connection.phase === "connected";
  const search = query.trim().toLocaleLowerCase();
  const matching = groups
    .map((group) => ({
      ...group,
      threads: group.threads.filter(
        (thread) =>
          (!search ||
            [group.label, thread.title, thread.branch, thread.modelSelection.model]
              .join(" ")
              .toLocaleLowerCase()
              .includes(search)) &&
          (filter === "all" ||
            (filter === "attention"
              ? agentNeedsAttention(thread)
              : agentStatus(thread) === "Working")),
      ),
    }))
    .filter(
      (group) =>
        (filter === "all" && (!search || group.label.toLocaleLowerCase().includes(search))) ||
        group.threads.length,
    );
  return (
    <section className={styles.computer} aria-label={`${environment.label} agents`}>
      <div className={styles.computerHeading}>
        <h2>{environment.label}</h2>
        <span>
          {connected ? "Connected" : "Last observed"} · {groups.length}{" "}
          {groups.length === 1 ? "workspace" : "workspaces"} · {threads.length}{" "}
          {threads.length === 1 ? "agent" : "agents"}
        </span>
      </div>
      {!connected || result._tag === "Failure" ? (
        <p role="status" className={styles.notice}>
          Connection unavailable. Agents and workspaces show their last observed state.
        </p>
      ) : null}
      {matching.map((group) => (
        <WorkspaceAgents
          key={`${installation ?? ""}:${group.id}`}
          group={group}
          environmentId={environment.environmentId}
          installation={installation}
          connected={connected}
          revealMatches={Boolean(search) || filter !== "all" || archived}
          showExternal={!search && filter === "all"}
        />
      ))}
      {!matching.length ? (
        <p className={styles.empty}>
          {!view && AsyncResult.isInitial(result)
            ? "Loading workspaces…"
            : query || filter !== "all"
              ? "No workspaces or agents match these filters."
              : "No workspaces or agents yet."}
        </p>
      ) : null}
      {view?.nextOffset != null ? (
        <button className={styles.more} onClick={() => setOffset(view.nextOffset!)}>
          Load more workspaces
        </button>
      ) : null}
    </section>
  );
}
function WorkspaceAgents({
  group,
  environmentId,
  installation,
  connected,
  revealMatches,
  showExternal,
}: {
  group: AgentWorkspaceGroup;
  environmentId: EnvironmentId;
  installation: string | undefined;
  connected: boolean;
  revealMatches: boolean;
  showExternal: boolean;
}) {
  const contentId = useId();
  const activeThreads = group.threads.filter(
    (thread) =>
      !thread.archivedAt &&
      (agentNeedsAttention(thread) || ["Working", "Waiting"].includes(agentStatus(thread))),
  );
  const hasActiveAgents = activeThreads.length > 0;
  const [expanded, setExpanded] = useState(hasActiveAgents || revealMatches);
  const [showAll, setShowAll] = useState(false);
  // Follow new activity and explicit filters, while allowing a manual collapse
  // to survive ordinary streaming updates within the same activity state.
  useEffect(() => {
    setExpanded(hasActiveAgents || revealMatches);
    setShowAll(false);
  }, [hasActiveAgents, revealMatches]);
  const visibleThreads = showAll || revealMatches ? group.threads : activeThreads;
  return (
    <section className={styles.workspace} aria-label={`${group.label} agents`}>
      <header className={styles.workspaceHeading}>
        <button
          type="button"
          className={styles.workspaceToggle}
          aria-label={`${expanded ? "Collapse" : "Expand"} agents for ${group.label}`}
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => {
            setExpanded(!expanded);
            if (!expanded) setShowAll(true);
          }}
        >
          {expanded ? <ChevronDownIcon size={16} /> : <ChevronRightIcon size={16} />}
          <FolderGit2Icon size={20} />
          <span className={styles.workspaceLabel}>
            <span className={styles.workspaceName}>{group.label}</span>
            <span>
              {group.threads.length} {group.threads.length === 1 ? "agent" : "agents"}
              {activeThreads.length ? ` · ${activeThreads.length} active` : ""}
              {group.resources.length > 1 ? ` · ${group.resources.length} checkouts` : ""}
            </span>
          </span>
        </button>
        {group.resources[0] && installation ? (
          <Link
            to="/workspaces"
            search={{
              environment: environmentId,
              workspace:
                group.resources[0].workspace?.lane?.sourceStackID ?? group.resources[0].workspaceID,
              tab: "agents",
              expectedInstallationID: installation,
            }}
          >
            Open workspace <ArrowRightIcon size={14} />
          </Link>
        ) : null}
      </header>
      <div id={contentId} hidden={!expanded}>
        {expanded ? (
          <>
            {visibleThreads
              .toSorted(
                (a, b) =>
                  Number(agentNeedsAttention(b)) - Number(agentNeedsAttention(a)) ||
                  b.updatedAt.localeCompare(a.updatedAt),
              )
              .map((thread) => (
                <Link
                  key={thread.id}
                  className={styles.agent}
                  to="/$environmentId/$threadId"
                  params={buildThreadRouteParams({
                    environmentId,
                    threadId: thread.id,
                  })}
                >
                  <BotIcon size={18} />
                  <div>
                    <strong>{thread.title}</strong>
                    <span>
                      {thread.modelSelection.model}
                      {thread.branch ? ` · ${thread.branch}` : ""} ·{" "}
                      {formatRelativeTimeLabel(thread.updatedAt)}
                    </span>
                  </div>
                  <span
                    className={styles.status}
                    data-attention={connected && agentNeedsAttention(thread)}
                  >
                    {!connected ? "Last observed · " : ""}
                    {agentStatus(thread)}
                  </span>
                  <ArrowRightIcon size={14} />
                </Link>
              ))}
            {!group.threads.length ? (
              <p className={styles.notice}>
                No agents here yet. Open the workspace to start a conversation.
              </p>
            ) : null}
            {!revealMatches &&
            activeThreads.length > 0 &&
            activeThreads.length < group.threads.length ? (
              <button
                type="button"
                className={styles.showAgents}
                onClick={() => setShowAll(!showAll)}
              >
                {showAll ? "Show active agents only" : `Show all ${group.threads.length} agents`}
              </button>
            ) : null}
            {expanded && installation && showExternal && group.resources.length ? (
              <WorkspaceExternalAgents
                environmentId={environmentId}
                installationID={installation}
                resources={group.resources}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
function WorkspaceExternalAgents({
  environmentId,
  installationID,
  resources,
}: {
  environmentId: EnvironmentId;
  installationID: string;
  resources: readonly AgentResource[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className={styles.external} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Agents from other apps</summary>
      {open
        ? resources
            .filter((resource) => resource.available)
            .map((resource) => (
              <ExternalSessionList
                key={resource.workspaceID}
                environmentId={environmentId}
                installationID={installationID}
                workspaceID={resource.workspaceID}
                generation={resource.generation}
              />
            ))
        : null}
    </details>
  );
}
