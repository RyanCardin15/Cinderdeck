import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import type { EnvironmentId } from "@cinderdeck/contracts";
import { BotIcon, FolderGit2Icon, SearchIcon, ArrowRightIcon } from "lucide-react";
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
        <section key={group.id} className={styles.workspace} aria-label={`${group.label} agents`}>
          <header className={styles.workspaceHeading}>
            <FolderGit2Icon size={20} />
            <div>
              <h3>{group.label}</h3>
              <span>
                {group.threads.length} {group.threads.length === 1 ? "agent" : "agents"}
                {group.resources.length > 1 ? ` · ${group.resources.length} checkouts` : ""}
              </span>
            </div>
            {group.resources[0] && installation ? (
              <Link
                to="/workspaces"
                search={{
                  environment: environment.environmentId,
                  workspace:
                    group.resources[0].workspace?.lane?.sourceStackID ??
                    group.resources[0].workspaceID,
                  tab: "agents",
                  expectedInstallationID: installation,
                }}
              >
                Open workspace <ArrowRightIcon size={14} />
              </Link>
            ) : null}
          </header>
          {group.threads
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
                  environmentId: environment.environmentId,
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
          {installation && !search && filter === "all" && group.resources.length ? (
            <WorkspaceExternalAgents
              environmentId={environment.environmentId}
              installationID={installation}
              resources={group.resources}
            />
          ) : null}
        </section>
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
