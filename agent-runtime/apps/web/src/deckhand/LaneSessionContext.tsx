import { LinkedWorkContext } from "./LinkedWorkContext";
import { PreviewCaptureControl } from "./PreviewCaptureControl";
import { RecordingContextSummary } from "./RecordingContextSummary";
import { ReviewerLauncher } from "./ReviewerLauncher";
import { ManagedSessionControl } from "./ManagedSessionControl";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { Link } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ThreadContextView } from "@t3tools/contracts/deckhand/rpc";
import {
  ArrowUpRightIcon,
  CircleAlertIcon,
  GitBranchIcon,
  GlobeIcon,
  TerminalIcon,
  FilesIcon,
  ChevronRightIcon,
} from "lucide-react";
import type { ProviderInstanceEntry } from "../providerInstances";
import { useEnvironmentQuery } from "../state/query";
import { threadContextView } from "./state";
import styles from "./laneSession.module.css";
import { useAgentObservation } from "./useAgentObservation";
import { connectedWorkspaceSearch } from "./workspaceNavigation";

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
export function LaneSessionContext({
  context,
  threadRef,
  stale: suppliedStale,
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
  const observation = useAgentObservation(
    threadRef.environmentId,
    JSON.stringify([
      threadRef.environmentId,
      threadRef.threadId,
      context.workspace.environmentId,
      context.checkout.laneId ?? context.workspace.ownerId,
      context.checkout.nativeGeneration,
    ]),
    context,
  );
  const inherited =
    context.requestedThreadId !== undefined &&
    context.requestedThreadId !== context.session.threadId;
  const stale = suppliedStale || observation.stale || inherited;
  const native = stale ? null : context.native?.workspace;
  const connected = !stale && context.nativeConnection === "connected" && Boolean(native);
  const services = native?.services ?? [];
  const previewService = services.find(
    (service) => service.ready && /^https?:\/\//i.test(service.url ?? ""),
  );
  const repository = context.checkout.repositories.find((repo) =>
    context.session.repositoryScope?.includes(repo.physicalId),
  );
  const workspaceSearch = connectedWorkspaceSearch(threadRef.environmentId, context);
  return (
    <section className={styles.context} aria-label="Connected lane controls">
      <div className={styles.titleRow}>
        <div className={styles.heading}>
          <div className={styles.metadata}>
            <span aria-label={repository?.root}>
              <GitBranchIcon aria-hidden size={15} />
              <code>{repository?.branch ?? "Detached checkout"}</code>
            </span>
            <span className={styles.connection} data-connected={connected}>
              <span aria-hidden className={styles.dot} />
              {stale
                ? "Last observed"
                : connected
                  ? "Workspace connected"
                  : "Workspace unavailable"}
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
          {inherited
            ? "Helper task in this parent’s lane. Managed checkout actions belong to the parent session."
            : "Saved conversation context. Reconnect Cinderdeck to inspect current services."}
        </p>
      ) : null}
      <div className={styles.tools}>
        <nav className={styles.views} aria-label="Lane tools">
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
                  These addresses belong to the execution computer. Open Cinderdeck there to use the
                  integrated preview.
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
          <ManagedSessionControl threadRef={threadRef} context={context} enabled={connected} />
          <LinkedWorkContext threadRef={threadRef} context={context} enabled={connected} />
          {context.session.role === "writer" ? (
            <ReviewerLauncher
              key={`${threadRef.environmentId}:${threadRef.threadId}`}
              threadRef={threadRef}
              providerSessionId={
                context.session.role === "writer" ? context.session.providerSessionId : null
              }
              enabled={
                connected &&
                context.checkout.state === "ready" &&
                context.feature.status === "active"
              }
            />
          ) : null}
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
    </section>
  );
}
