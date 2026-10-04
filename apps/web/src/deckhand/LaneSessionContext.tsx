import { LinkedWorkContext } from "./LinkedWorkContext";
import { PreviewCaptureControl } from "./PreviewCaptureControl";
import { RecordingContextSummary } from "./RecordingContextSummary";
import { ReviewerLauncher } from "./ReviewerLauncher";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { Link } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ThreadContextView } from "@t3tools/contracts/deckhand/rpc";
import {
  ArrowUpRightIcon,
  CircleAlertIcon,
  GitBranchIcon,
  GlobeIcon,
  LayersIcon,
  TerminalIcon,
  FilesIcon,
  ChevronRightIcon,
} from "lucide-react";
import type { ProviderInstanceEntry } from "../providerInstances";
import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { buildThreadRouteParams } from "../threadRoutes";
import { useEnvironmentQuery } from "../state/query";
import { threadContextView } from "./state";
import styles from "./laneSession.module.css";

export function useLaneSessionContext(threadRef: ScopedThreadRef | null) {
  return useEnvironmentQuery(
    threadRef
      ? threadContextView({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
  );
}
const stateLabels: Record<ThreadContextView["session"]["execution"], string> = {
  queued: "Queued",
  starting: "Starting",
  working: "Working",
  waiting_input: "Needs your input",
  waiting_approval: "Needs approval",
  idle: "Idle",
  finished_turn: "Turn complete",
  interrupted: "Interrupted",
  failed: "Failed",
  unknown: "Unknown",
};
export function LaneSessionContext({
  context,
  threadRef,
  providers,
  stale,
  previewAvailable,
  onOpenPreview,
  onOpenDiff,
  onOpenTerminal,
  onOpenSource,
  onOpenPullRequests,
  pullRequestsAvailable,
  pullRequestCount,
}: {
  context: ThreadContextView;
  threadRef: ScopedThreadRef;
  providers: ReadonlyArray<ProviderInstanceEntry>;
  stale: boolean;
  previewAvailable: boolean;
  onOpenPreview: (url: string) => void;
  onOpenDiff: () => void;
  onOpenTerminal: () => void;
  onOpenSource: () => void;
  onOpenPullRequests: () => void;
  pullRequestsAvailable: boolean;
  pullRequestCount: number;
}) {
  const native = stale ? null : context.native?.workspace;
  const connected = !stale && context.nativeConnection === "connected" && Boolean(native);
  const services = native?.services ?? [];
  const previewService = services.find(
    (service) => service.ready && /^https?:\/\//i.test(service.url ?? ""),
  );
  const repository = context.checkout.repositories.find((repo) =>
    context.session.repositoryScope?.includes(repo.physicalId),
  );
  const workspaceSearch = {
    workspace: context.workspace.ownerId,
    context: context.checkout.laneId ?? context.workspace.ownerId,
  };
  const label =
    context.checkout.kind === "lane"
      ? (native?.lane?.name ?? context.feature.title)
      : "Primary checkout";
  return (
    <section className={styles.context} aria-label="Connected lane context">
      <div className={styles.breadcrumb}>
        <Link to="/workspaces">Workspaces</Link>
        <ChevronRightIcon aria-hidden size={13} />
        <Link to="/workspaces" search={{ workspace: context.workspace.ownerId }}>
          {context.workspace.name}
        </Link>
        <ChevronRightIcon aria-hidden size={13} />
        <span>{label}</span>
      </div>
      <div className={styles.titleRow}>
        <div className={styles.heading}>
          <h1>{context.feature.title}</h1>
          <div className={styles.metadata}>
            <span aria-label={repository?.root}>
              <GitBranchIcon aria-hidden size={15} />
              <code>{repository?.branch ?? "Detached checkout"}</code>
            </span>
            <span className={styles.connection} data-connected={connected}>
              <span aria-hidden className={styles.dot} />
              {connected ? "Cinderdeck connected" : "Cinderdeck unavailable"}
            </span>
            <span className={styles.role}>
              {context.session.role} · {context.session.desiredAccess.replaceAll("_", " ")}
            </span>
          </div>
        </div>
        {previewService && previewAvailable ? (
          <button
            type="button"
            className={styles.primary}
            onClick={() => onOpenPreview(previewService.url!)}
          >
            Open preview
            <ArrowUpRightIcon aria-hidden size={15} />
          </button>
        ) : null}
      </div>
      {!connected ? (
        <p className={styles.warning} role="status">
          <CircleAlertIcon aria-hidden size={14} />
          Saved conversation context. Reconnect Cinderdeck to inspect current services.
        </p>
      ) : null}
      <div className={styles.tools}>
        <nav className={styles.views} aria-label="Lane views">
          <Link to="/workspaces" search={workspaceSearch}>
            <LayersIcon aria-hidden size={15} />
            Overview
          </Link>
          <span aria-current="page">
            Agents<span className={styles.count}>{context.sessions.length}</span>
          </span>
          <button
            type="button"
            onClick={onOpenPullRequests}
            disabled={!pullRequestsAvailable}
            aria-label={
              pullRequestsAvailable
                ? "Open linked pull requests"
                : "No pull requests linked to this conversation"
            }
          >
            <PullRequestGlyph.pullRequest aria-hidden size={15} />
            Pull requests<span className={styles.count}>{pullRequestCount}</span>
          </button>
          <details className={styles.services}>
            <summary>
              Services<span className={styles.count}>{services.length}</span>
            </summary>
            <div className={styles.servicePopover}>
              <h2>Services in this checkout</h2>
              {!services.length ? (
                <p>
                  {connected ? "No services configured." : "Current service state is unavailable."}
                </p>
              ) : null}
              {services.map((service) => (
                <div key={service.name} className={styles.service}>
                  <strong>{service.name}</strong>
                  <span>
                    {service.status} · {service.ready ? "Ready" : service.phase}
                  </span>
                  {service.sharedFrom ? <small>Shared from {service.sharedFrom}</small> : null}
                  <code>{service.url ?? service.command ?? ""}</code>
                  {service.ready &&
                  service.url &&
                  /^https?:\/\//i.test(service.url) &&
                  previewAvailable ? (
                    <button type="button" onClick={() => onOpenPreview(service.url!)}>
                      Preview <ArrowUpRightIcon aria-hidden size={13} />
                    </button>
                  ) : null}
                </div>
              ))}
              {!previewAvailable && services.some((service) => service.url) ? (
                <p>
                  These addresses belong to the execution computer. Open Deckhand desktop there to
                  use the integrated preview.
                </p>
              ) : null}
              <Link to="/workspaces" search={workspaceSearch}>
                Manage services in workspace
                <ChevronRightIcon aria-hidden size={13} />
              </Link>
            </div>
          </details>
          {context.checkout.nativeGeneration ? (
            <PreviewCaptureControl
              key={`${threadRef.environmentId}:${context.session.id}`}
              threadRef={threadRef}
              sessionID={context.session.id}
              context={{
                installationID: context.workspace.environmentId,
                workspaceID: context.checkout.laneId ?? context.workspace.ownerId,
                generation: context.checkout.nativeGeneration,
              }}
              enabled={connected && previewAvailable}
            />
          ) : null}
          {context.checkout.nativeGeneration ? (
            <RecordingContextSummary
              environmentId={threadRef.environmentId}
              context={{
                installationID: context.workspace.environmentId,
                workspaceID: context.checkout.laneId ?? context.workspace.ownerId,
                generation: context.checkout.nativeGeneration,
              }}
              enabled={connected}
            />
          ) : null}
        </nav>
        <div className={styles.panelActions} aria-label="Repository panels">
          <LinkedWorkContext threadRef={threadRef} context={context} enabled={connected} />
          <ReviewerLauncher
            key={`${threadRef.environmentId}:${threadRef.threadId}`}
            threadRef={threadRef}
            providerSessionId={
              context.session.role === "writer" ? context.session.providerSessionId : null
            }
            enabled={
              connected && context.checkout.state === "ready" && context.feature.status === "active"
            }
          />
          <button
            type="button"
            onClick={onOpenSource}
            aria-label="Source files in this session’s repository"
          >
            <FilesIcon aria-hidden size={15} />
            <span>Source</span>
          </button>
          <button
            type="button"
            onClick={onOpenDiff}
            aria-label="Changes in this session’s checkout"
          >
            <GitBranchIcon aria-hidden size={15} />
            <span>Diff</span>
          </button>
          <button
            type="button"
            onClick={onOpenTerminal}
            aria-label="Shell in this session’s repository"
          >
            <TerminalIcon aria-hidden size={15} />
            <span>Terminal</span>
          </button>
          {previewService && !previewAvailable ? (
            <span
              aria-label="Preview addresses belong to the execution computer"
              className={styles.hostPreview}
            >
              <GlobeIcon aria-hidden size={15} />
              Host preview
            </span>
          ) : null}
        </div>
      </div>
      <nav className={styles.sessions} aria-label="Agent conversations in this lane">
        {context.sessions.map((session) => {
          const provider = providers.find(
            (item) => item.instanceId === session.binding.providerInstanceId,
          );
          const selected = session.binding.threadId === threadRef.threadId;
          const execution =
            stale || session.source === "unavailable" ? "unknown" : session.binding.execution;
          return (
            <Link
              key={session.binding.id}
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams({
                environmentId: threadRef.environmentId,
                threadId: session.binding.threadId,
              })}
              className={styles.session}
              data-active={selected}
              aria-current={selected ? "page" : undefined}
              aria-label={`${session.title} · ${session.binding.role}`}
            >
              <span className={styles.providerMark}>
                {provider ? (
                  <ProviderInstanceIcon
                    driverKind={provider.driverKind}
                    displayName={provider.displayName}
                    showBadge={false}
                  />
                ) : (
                  <LayersIcon aria-hidden size={19} />
                )}
              </span>
              <span>
                <strong>{provider?.displayName ?? session.binding.providerInstanceId}</strong>
                <small>
                  {session.binding.role}
                  {session.archived ? " · Archived" : ""}
                </small>
              </span>
              <span className={styles.sessionState} data-state={execution}>
                <span className={styles.dot} aria-hidden />
                {stateLabels[execution]}
              </span>
            </Link>
          );
        })}
        {context.sessions.length === 20 ? (
          <span className={styles.historyNote}>20 newest sessions</span>
        ) : null}
      </nav>
    </section>
  );
}
