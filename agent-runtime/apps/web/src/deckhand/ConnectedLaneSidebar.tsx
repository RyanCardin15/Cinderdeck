import { Link } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@cinderdeck/contracts";
import { ChevronLeftIcon, GitBranchIcon, MessageSquareIcon } from "lucide-react";
import { buildThreadRouteParams } from "../threadRoutes";
import { useLaneSessionContext } from "./LaneSessionContext";
import styles from "./laneSession.module.css";
import { useAgentObservation } from "./useAgentObservation";
import { connectedWorkspaceSearch } from "./workspaceNavigation";
import { agentExecutionLabel, agentProviderLabel, agentCheckoutLabel } from "./agentPresentation";

const noProviders: ReadonlyArray<{ readonly instanceId: string; readonly displayName: string }> =
  [];

export function ConnectedLaneSidebar({
  threadRef,
  providers = noProviders,
}: {
  threadRef: ScopedThreadRef | null;
  providers?: ReadonlyArray<{ readonly instanceId: string; readonly displayName: string }>;
}) {
  const result = useLaneSessionContext(threadRef);
  const context = result.data;
  const observation = useAgentObservation(
    threadRef?.environmentId ?? null,
    JSON.stringify([
      threadRef?.environmentId,
      threadRef?.threadId,
      context?.workspace.environmentId,
      context?.checkout.laneId ?? context?.workspace.ownerId,
      context?.checkout.nativeGeneration,
    ]),
    context,
  );
  if (!context || !threadRef) return null;
  const workspaceSearch = connectedWorkspaceSearch(threadRef.environmentId, context);
  return (
    <section className={styles.sidebarContext} aria-label="Current connected lane">
      <Link className={styles.backLink} to="/workspaces" search={workspaceSearch}>
        <ChevronLeftIcon aria-hidden size={14} />
        {context.workspace.name}
      </Link>
      <div className={styles.sidebarLane}>
        <GitBranchIcon aria-hidden size={16} />
        <strong>
          {agentCheckoutLabel(context.checkout, context.native?.workspace?.lane?.name)}
        </strong>
      </div>
      <p className={styles.sidebarObjective}>{context.feature.title}</p>
      <p className={styles.sidebarObjective}>{context.feature.objective}</p>
      {result.error || observation.stale ? (
        <p className={styles.sidebarObjective} role="status">
          Last observed · Current agent state unavailable
        </p>
      ) : null}
      <h2 className={styles.sidebarLabel}>Lane agents</h2>
      <nav aria-label="Conversations in current lane">
        {context.sessions.slice(0, 6).map((session) => (
          <Link
            key={session.binding.id}
            to="/$environmentId/$threadId"
            params={buildThreadRouteParams({
              environmentId: threadRef.environmentId,
              threadId: session.binding.threadId,
            })}
            aria-current={session.binding.threadId === threadRef.threadId ? "page" : undefined}
          >
            <MessageSquareIcon aria-hidden size={14} />
            <span>
              {session.title}
              <small>
                {agentProviderLabel(session.binding.providerInstanceId, providers)} ·{" "}
                {session.binding.role}
              </small>
            </span>
            <span className={styles.sidebarState}>
              {agentExecutionLabel(
                session.binding.execution,
                Boolean(result.error) || observation.stale || session.source === "unavailable",
              )}
            </span>
          </Link>
        ))}
      </nav>
      {context.sessions.length > 6 ? (
        <Link
          className={styles.backLink}
          to="/workspaces"
          search={connectedWorkspaceSearch(threadRef.environmentId, context, "agents")}
        >
          View lane sessions
        </Link>
      ) : null}
    </section>
  );
}
