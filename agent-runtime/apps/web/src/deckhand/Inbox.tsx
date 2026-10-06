import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@cinderdeck/contracts";
import type {
  AttentionItem,
  AttentionListInput,
  AttentionPage,
} from "@cinderdeck/contracts/deckhand/attentionRpc";
import {
  ArrowRightIcon,
  InboxIcon,
  ClockIcon,
  EyeIcon,
  RotateCcwIcon,
  CircleAlertIcon,
  RefreshCwIcon,
  FolderGit2Icon,
  SearchIcon,
  ShieldCheckIcon,
} from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  useThreadShells,
  useProjects,
  useAllEnvironmentShellsBootstrapped,
} from "../state/entities";
import { useEnvironments, type EnvironmentPresentation } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { readPullRequestListPreferences } from "../components/pullRequest/pullRequestListPreferences";
import { ProductNavigation } from "./ProductNavigation";
import { workspaceView } from "./state";
import { attentionList, attentionChange } from "./attentionState";
import { groupWorkspaceAgents, type AgentResource } from "./agentWorkspaceGroups";
import { InboxApproval } from "./InboxApproval";
import styles from "./inbox.module.css";
type View = AttentionListInput["view"];
export function Inbox() {
  const threads = useThreadShells();
  const ready = useAllEnvironmentShellsBootstrapped();
  const { environments } = useEnvironments();
  const [view, setView] = useState<View>("active");
  const [unread, setUnread] = useState(false);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  return (
    <div className={styles.shell}>
      <ProductNavigation current="inbox" />
      <main className={styles.main}>
        <header>
          <span className={styles.eyebrow}>Your work</span>
          <h1>Inbox</h1>
          <p>What needs you, organized by workspace. Review requests and take action right here.</p>
        </header>
        <div className={styles.filters}>
          {(["active", "snoozed", "history"] as const).map((value) => (
            <button key={value} aria-pressed={view === value} onClick={() => setView(value)}>
              {value === "snoozed" ? (
                <ClockIcon size={15} />
              ) : value === "history" ? (
                <RotateCcwIcon size={15} />
              ) : (
                <InboxIcon size={15} />
              )}
              {{ active: "Needs attention", snoozed: "Snoozed", history: "Resolved" }[value]}
            </button>
          ))}
          <label>
            <input type="checkbox" checked={unread} onChange={(e) => setUnread(e.target.checked)} />{" "}
            Unread only
          </label>
        </div>
        <div className={styles.searchbar}>
          <label>
            <SearchIcon size={16} />
            <input
              type="search"
              aria-label="Search attention items"
              placeholder="Search workspaces, agents and requests…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <select
            aria-label="Attention type"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="all">All attention</option>
            <option value="approval">Approvals</option>
            <option value="input">Questions & sign-in</option>
            <option value="review">Reviews & plans</option>
            <option value="failure">Failures & connections</option>
          </select>
        </div>
        {!ready ? (
          <p role="status" className={styles.alert}>
            Computers are still synchronizing. Saved items may be out of date.
          </p>
        ) : null}
        {environments.map((environment) => (
          <ComputerInbox
            key={`${environment.environmentId}:${view}`}
            environment={environment}
            threads={threads.filter((thread) => thread.environmentId === environment.environmentId)}
            view={view}
            unread={unread}
            query={query}
            kind={kind}
          />
        ))}
        {!environments.length ? (
          <div className={styles.empty}>
            <InboxIcon size={32} />
            <h2>Connect your work</h2>
            <p>Connect an execution computer to see its questions, reviews and saved failures.</p>
            <Link to="/settings/connections">
              Manage connections <ArrowRightIcon size={15} />
            </Link>
          </div>
        ) : null}
      </main>
    </div>
  );
}
function AttentionDestination({
  item,
  environmentId,
}: {
  item: AttentionItem;
  environmentId: EnvironmentId;
}) {
  const target = item.target;
  const threadId =
    target.kind === "thread" ? target.threadId : target.kind === "review" ? target.threadId : null;
  if (threadId)
    return (
      <Link
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams({ environmentId, threadId })}
      >
        {item.kind === "input"
          ? "Respond"
          : item.kind === "auth"
            ? "Sign in"
            : item.kind === "plan"
              ? "Review plan"
              : "Open conversation"}{" "}
        <ArrowRightIcon size={14} />
      </Link>
    );
  if (target.kind === "runs") {
    const search = {
      environment: environmentId,
      workspace: target.context.workspaceID,
      run: target.runID,
      expectedGeneration: target.context.generation,
      expectedInstallationID: target.context.installationID,
    };
    return (
      <>
        <Link to="/services" search={search}>
          {item.state === "resolved" ? "Inspect original run" : "Inspect run"}{" "}
          <ArrowRightIcon size={14} />
        </Link>
        {target.resolvedByRunID ? (
          <Link to="/services" search={{ ...search, run: target.resolvedByRunID }}>
            Open matching rerun <ArrowRightIcon size={14} />
          </Link>
        ) : null}
      </>
    );
  }
  if (target.kind === "verification")
    return (
      <Link
        to="/pull-requests"
        search={{
          ...readPullRequestListPreferences(),
          environmentId,
          projectId: target.reference.projectId,
          repository: target.reference.repository,
          number: target.reference.number,
          ...(target.reference.host ? { host: target.reference.host } : {}),
        }}
      >
        Inspect verification <ArrowRightIcon size={14} />
      </Link>
    );
  if (target.kind === "connection")
    return (
      <Link to="/workspaces" search={{ environment: environmentId }}>
        Reconnect workspace <ArrowRightIcon size={14} />
      </Link>
    );
  if (target.kind === "review")
    return (
      <Link
        to="/workspaces"
        search={{
          environment: environmentId,
          workspace: target.baseWorkspaceID,
          context: target.context.workspaceID,
          expectedGeneration: target.context.generation,
          expectedInstallationID: target.context.installationID,
        }}
      >
        Inspect reviewer request <ArrowRightIcon size={14} />
      </Link>
    );
  return null;
}
function ComputerInbox({
  environment,
  threads,
  view,
  unread,
  query,
  kind,
}: {
  environment: EnvironmentPresentation;
  threads: ReturnType<typeof useThreadShells>;
  view: View;
  unread: boolean;
  query: string;
  kind: string;
}) {
  const environmentId = environment.environmentId;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const connected = environment.connection.phase === "connected";
  const list = useAtomCommand(attentionList, { reportFailure: false });
  const change = useAtomCommand(attentionChange, { reportFailure: false });
  const [page, setPage] = useState<AttentionPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [nativeOffset, setNativeOffset] = useState(0);
  const nativeResult = useAtomValue(
    workspaceView({ environmentId, input: { offset: nativeOffset, limit: 100 } }),
  );
  const native = Option.getOrNull(AsyncResult.value(nativeResult));
  const [catalog, setCatalog] = useState<Record<string, AgentResource>>({});
  const installation = native?.hello?.installationID;
  useEffect(() => {
    setCatalog({});
  }, [installation]);
  useEffect(() => {
    if (native)
      setCatalog((previous) => ({
        ...previous,
        ...Object.fromEntries(native.resources.map((resource) => [resource.workspaceID, resource])),
      }));
  }, [native]);
  const sources = useMemo(
    () => ({
      threadIds: threads.map((thread) => thread.id),
      contexts:
        native?.hello && native.state === "connected"
          ? native.resources
              .filter((resource) => resource.available)
              .map((resource) => ({
                installationID: native.hello!.installationID,
                workspaceID: resource.workspaceID,
                generation: resource.generation,
              }))
          : [],
    }),
    [threads, native],
  );
  const sourceKey = JSON.stringify(sources);
  const shellStamp = JSON.stringify(
    threads.map((thread) => [
      thread.id,
      thread.hasPendingApprovals,
      thread.source.pendingRuntimeRequest?.id,
      thread.hasPendingUserInput,
      thread.hasActionableProposedPlan,
      thread.runtime?.status,
      thread.runtime?.lastError,
      thread.archivedAt,
    ]),
  );
  const pages = Math.max(
    1,
    Math.ceil(sources.threadIds.length / 100),
    Math.ceil(sources.contexts.length / 16),
  );
  const source = JSON.parse(sourceKey) as typeof sources;
  const slice = cursor % pages;
  const inputKey = JSON.stringify({
    threadIds: source.threadIds.slice(slice * 100, (slice + 1) * 100),
    nativeContexts: source.contexts.slice(slice * 16, (slice + 1) * 16),
    offset,
    limit: 100,
    view,
  });
  const requestNumber = useRef(0);
  const requestKey = JSON.stringify([inputKey, refresh, shellStamp]);
  useEffect(() => {
    if (!connected) return;
    const interval = window.setInterval(() => {
      setCursor((value) => {
        if ((value + 1) % pages === 0) setNativeOffset(native?.nextOffset ?? 0);
        return value + 1;
      });
      setRefresh((value) => value + 1);
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [connected, pages, native?.nextOffset]);
  useEffect(() => {
    if (!connected) return;
    const number = ++requestNumber.current;
    let cancelled = false;
    void list({
      environmentId,
      input: JSON.parse(
        (JSON.parse(requestKey) as [string, number, string])[0],
      ) as AttentionListInput,
    }).then((result) => {
      if (cancelled || number !== requestNumber.current) return;
      if (result._tag === "Success") {
        setPage(result.value);
        setFailed(false);
      } else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [connected, environmentId, list, requestKey]);
  const act = async (item: AttentionItem, action: "read" | "unread" | "snooze" | "unsnooze") => {
    setBusy(item.id);
    setMessage(null);
    try {
      const result = await change({
        environmentId,
        input: {
          id: item.id,
          causeVersion: item.causeVersion,
          revision: item.revision,
          dispositionRevision: item.dispositionRevision,
          action,
          ...(action === "snooze"
            ? { snoozedUntil: new Date(Date.now() + 3600_000).toISOString() }
            : {}),
        },
      });
      if (result._tag !== "Success")
        setMessage(
          "This cause changed or its source could not be refreshed. Check the original work before trying again.",
        );
      setRefresh((value) => value + 1);
    } finally {
      setBusy(null);
    }
  };
  const workspaceGroups = groupWorkspaceAgents(Object.values(catalog), projects, threads);
  const groupFor = (item: AttentionItem) => {
    const target = item.target;
    if (target.kind === "thread" || (target.kind === "review" && target.threadId))
      return workspaceGroups.find((group) =>
        group.threads.some((thread) => thread.id === target.threadId),
      );
    if (target.kind === "runs" || target.kind === "review")
      return workspaceGroups.find((group) =>
        group.resources.some((resource) => resource.workspaceID === target.context.workspaceID),
      );
    if (target.kind === "verification")
      return workspaceGroups.find((group) =>
        group.threads.some((thread) => thread.projectId === target.reference.projectId),
      );
    return undefined;
  };
  const agentFor = (item: AttentionItem) =>
    item.target.kind === "thread" || item.target.kind === "review"
      ? threads.find(
          (thread) =>
            thread.id ===
            (item.target.kind === "thread" || item.target.kind === "review"
              ? item.target.threadId
              : null),
        )
      : undefined;
  const items =
    page?.items
      .filter(
        (item) =>
          (!unread || !item.read) &&
          (kind === "all" ||
            (kind === "approval"
              ? item.kind === "approval"
              : kind === "input"
                ? ["input", "auth"].includes(item.kind)
                : kind === "review"
                  ? ["plan", "review_ready", "review_blocked", "verification"].includes(item.kind)
                  : ["agent_failure", "run_failure", "connection"].includes(item.kind))) &&
          (!query.trim() ||
            [item.title, item.detail, groupFor(item)?.label, agentFor(item)?.title]
              .join(" ")
              .toLocaleLowerCase()
              .includes(query.trim().toLocaleLowerCase())),
      )
      .toSorted(
        (a, b) =>
          Number(b.kind === "approval") - Number(a.kind === "approval") ||
          Number(b.severity === "error") - Number(a.severity === "error"),
      ) ?? [];
  const grouped = new Map<string, { label: string; items: AttentionItem[] }>();
  for (const item of items) {
    const workspace = groupFor(item);
    const id = workspace?.id ?? "other";
    const group = grouped.get(id) ?? {
      label: workspace?.label ?? "Other work & connections",
      items: [],
    };
    group.items.push(item);
    grouped.set(id, group);
  }
  return (
    <section className={styles.computer} aria-label={`${environment.label} attention`}>
      <div className={styles.computerHeading}>
        <h2>
          {environment.label}
          <span>{connected && !failed ? "Connected" : "Last observed"}</span>
          {page ? (
            <span>
              {page.total}{" "}
              {view === "active"
                ? page.total === 1
                  ? "needs attention"
                  : "need attention"
                : page.total === 1
                  ? "item"
                  : "items"}
            </span>
          ) : null}
        </h2>
        <button
          disabled={!connected || busy !== null}
          onClick={() => setRefresh((value) => value + 1)}
          aria-label={`Refresh ${environment.label} attention`}
        >
          <RefreshCwIcon size={14} /> Refresh
        </button>
      </div>
      {!connected || failed ? (
        <p role="status" className={styles.alert}>
          Current state is unavailable. Saved items are last observed; reconnect this computer to
          refresh them.
        </p>
      ) : null}
      {message ? (
        <p role="alert" className={styles.alert}>
          {message}
        </p>
      ) : null}
      {page?.warnings.map((warning) => (
        <p key={warning} role="status" className={styles.alert}>
          {warning}
        </p>
      ))}
      {pages > 1 || (native?.nextOffset !== null && native?.nextOffset !== undefined) ? (
        <p className={styles.batch}>
          Sources refresh in bounded batches. Items outside the latest batch retain their last
          observation.
        </p>
      ) : null}
      <div className={styles.list}>
        {[...grouped].map(([id, group]) => (
          <section
            className={styles.workspaceGroup}
            key={id}
            aria-label={`${group.label} attention`}
          >
            <div className={styles.workspaceHeading}>
              <FolderGit2Icon size={18} />
              <h3>{group.label}</h3>
              <span>
                {group.items.length} {group.items.length === 1 ? "item" : "items"}
              </span>
            </div>
            {group.items.map((item) => {
              const live = connected && !failed && item.freshness === "current";
              const agent = agentFor(item);
              const detail =
                item.kind === "approval" && item.target.kind === "thread"
                  ? item.state === "resolved"
                    ? "This approval request has been resolved."
                    : null
                  : agent && item.detail.startsWith(`${agent.title}: `)
                    ? item.detail.slice(agent.title.length + 2)
                    : item.detail;
              return (
                <article key={item.id} className={styles.item} data-read={item.read}>
                  <div className={styles.icon}>
                    {item.kind === "approval" ? (
                      <ShieldCheckIcon size={20} />
                    ) : (
                      <CircleAlertIcon size={20} />
                    )}
                  </div>
                  <div className={styles.content}>
                    <span className={styles.kind}>
                      {!live ? "Last observed · " : ""}
                      {item.state === "resolved"
                        ? "Resolved by source"
                        : item.kind.replaceAll("_", " ")}
                      {item.read ? " · Read" : " · Unread"}
                    </span>
                    <h2>{item.title}</h2>
                    {agent ? <strong className={styles.agentName}>{agent.title}</strong> : null}
                    {detail ? <p>{detail}</p> : null}
                    {item.kind === "approval" &&
                    item.state !== "resolved" &&
                    item.target.kind === "thread" ? (
                      <InboxApproval
                        key={`${item.id}:${item.causeVersion}`}
                        item={item}
                        environmentId={environmentId}
                        live={live}
                        onResolved={() => setRefresh((value) => value + 1)}
                      />
                    ) : null}
                    <small>
                      Observed {new Date(item.observedAt).toLocaleString()}
                      {item.target.kind === "runs" || item.target.kind === "review"
                        ? ` · Workspace generation ${item.target.context.generation}`
                        : ""}
                      {item.snoozedUntil
                        ? ` · Snoozed until ${new Date(item.snoozedUntil).toLocaleTimeString()}`
                        : ""}
                    </small>
                  </div>
                  <div className={styles.actions}>
                    <AttentionDestination item={item} environmentId={environmentId} />
                    <button
                      disabled={!live || busy !== null}
                      onClick={() => {
                        void act(item, item.read ? "unread" : "read");
                      }}
                    >
                      <EyeIcon size={14} />
                      {item.read ? "Mark unread" : "Mark read"}
                    </button>
                    {item.canSnooze && item.state !== "resolved" ? (
                      <button
                        disabled={!live || busy !== null}
                        onClick={() => {
                          void act(item, item.snoozedUntil ? "unsnooze" : "snooze");
                        }}
                      >
                        <ClockIcon size={14} />
                        {item.snoozedUntil ? "Wake now" : "Snooze for 1 hour"}
                      </button>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </section>
        ))}
      </div>
      {!page && !failed && connected ? (
        <p role="status" className={styles.batch}>
          Checking saved causes…
        </p>
      ) : page && !items.length ? (
        <div className={styles.empty}>
          <InboxIcon size={26} />
          <h3>
            {query || kind !== "all"
              ? "No items match these filters on this page"
              : unread
                ? "No unread items on this page"
                : view === "snoozed"
                  ? "Nothing snoozed on this page"
                  : view === "history"
                    ? "No resolved items on this page"
                    : "You’re all caught up on this page"}
          </h3>
          <p>
            Read and snoozed work stays saved. Its original source determines when it is resolved.
          </p>
        </div>
      ) : null}
      {page && offset > 0 ? (
        <button className={styles.pageButton} onClick={() => setOffset(Math.max(0, offset - 100))}>
          Previous page
        </button>
      ) : null}
      {page?.nextOffset !== null && page?.nextOffset !== undefined ? (
        <button className={styles.pageButton} onClick={() => setOffset(page.nextOffset!)}>
          Next page
        </button>
      ) : null}
    </section>
  );
}
