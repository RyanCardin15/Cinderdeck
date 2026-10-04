import { Link } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronLeftIcon, GitBranchIcon, MessageSquareIcon } from "lucide-react";
import { buildThreadRouteParams } from "../threadRoutes";
import { useLaneSessionContext } from "./LaneSessionContext";
import styles from "./laneSession.module.css";

export function ConnectedLaneSidebar({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  const result = useLaneSessionContext(threadRef);
  const context = result.data;
  if (!context || !threadRef) return null;
  return (
    <section className={styles.sidebarContext} aria-label="Current connected lane">
      <Link
        className={styles.backLink}
        to="/workspaces"
        search={{
          workspace: context.workspace.ownerId,
          context: context.checkout.laneId ?? context.workspace.ownerId,
        }}
      >
        <ChevronLeftIcon aria-hidden size={14} />
        {context.workspace.name}
      </Link>
      <div className={styles.sidebarLane}>
        <GitBranchIcon aria-hidden size={16} />
        <strong>{context.feature.title}</strong>
      </div>
      <p className={styles.sidebarObjective}>{context.feature.objective}</p>
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
              {session.binding.providerInstanceId}
              <small>{session.binding.role}</small>
            </span>
            <span className={styles.sidebarState}>
              {result.error || session.source === "unavailable"
                ? "Unknown"
                : session.binding.execution.replaceAll("_", " ")}
            </span>
          </Link>
        ))}
      </nav>
      {context.sessions.length > 6 ? (
        <Link
          className={styles.backLink}
          to="/workspaces"
          search={{
            workspace: context.workspace.ownerId,
            context: context.checkout.laneId ?? context.workspace.ownerId,
          }}
        >
          View lane sessions
        </Link>
      ) : null}
    </section>
  );
}
