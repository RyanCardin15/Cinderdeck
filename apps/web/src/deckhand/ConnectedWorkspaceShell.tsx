import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import type { ReactNode } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ThreadContextView } from "@t3tools/contracts/deckhand/rpc";
import {
  FolderGit2Icon,
  GitBranchIcon,
  LayersIcon,
  ServerIcon,
  FilmIcon,
  MessagesSquareIcon,
} from "lucide-react";
import { ProductNavigation } from "./ProductNavigation";
import { workspaceView } from "./state";
import {
  overviewResources,
  overviewWorkspaceContexts,
  connectedWorkspaceSearch,
} from "./workspaceNavigation";
import { SessionList } from "./SessionList";
import { useAgentObservation } from "./useAgentObservation";
import { environmentServerConfigsAtom } from "../state/server";
import { deriveProviderInstanceEntries } from "../providerInstances";
import styles from "./connectedShell.module.css";

/** Shares the operational navigator around the existing single ChatView. */
export function ConnectedWorkspaceShell({
  context,
  threadRef,
  children,
  stale: suppliedStale = false,
}: {
  context: ThreadContextView;
  threadRef: ScopedThreadRef;
  children: ReactNode;
  stale?: boolean;
}) {
  const baseID = context.workspace.ownerId;
  const contextID = context.checkout.laneId ?? baseID;
  const result = useAtomValue(
    workspaceView({
      environmentId: threadRef.environmentId,
      input: {
        offset: 0,
        limit: 48,
        selectedWorkspaceID: baseID,
        selectedContextID: contextID,
        workspacePage: { offset: 0, limit: 50 },
      },
    }),
  );
  const view = Option.getOrNull(AsyncResult.value(result));
  const observationScope = JSON.stringify([
    threadRef.threadId,
    context.workspace.environmentId,
    contextID,
    context.checkout.nativeGeneration,
  ]);
  const contextObservation = useAgentObservation(
    threadRef.environmentId,
    observationScope,
    context,
  );
  const workspaceObservation = useAgentObservation(
    threadRef.environmentId,
    `${observationScope}:workspaces`,
    view,
  );
  const sameInstallation = view?.hello?.installationID === context.workspace.environmentId;
  const treeStale =
    result._tag === "Failure" ||
    workspaceObservation.stale ||
    view?.state !== "connected" ||
    !sameInstallation;
  const stale = suppliedStale || contextObservation.stale || treeStale;
  const connected = !stale && context.nativeConnection === "connected";
  const resources = overviewResources(sameInstallation ? view : null);
  const bases = resources.filter((r) => r.workspace && !r.workspace.lane);
  const contexts = overviewWorkspaceContexts(sameInstallation ? view : null, baseID);
  const config = useAtomValue(environmentServerConfigsAtom);
  const providers = deriveProviderInstanceEntries(
    config.get(threadRef.environmentId)?.providers ?? [],
  );
  const search = connectedWorkspaceSearch(threadRef.environmentId, context, "agents");
  const current =
    context.native?.workspace?.lane?.name ??
    (context.checkout.laneId ? context.feature.title : "Primary");
  return (
    <div className={styles.shell}>
      <ProductNavigation
        current="conversations"
        workspaceSearch={search}
        connection={{
          connected,
          label: stale
            ? "Last observed workspace"
            : connected
              ? "Workspace connected"
              : "Workspace unavailable",
        }}
      >
        <div className={styles.treeHeading}>Workspaces</div>
        {treeStale ? (
          <p className={styles.treeHeading} role="status">
            {view ? "Last observed workspace list" : "Workspace list unavailable"}
          </p>
        ) : null}
        <nav className={styles.tree} aria-label="Workspaces and lanes">
          {bases.map((base) => (
            <div key={base.workspaceID}>
              <Link
                to="/workspaces"
                search={{
                  environment: threadRef.environmentId,
                  workspace: base.workspaceID,
                  context: base.workspaceID,
                  tab: "agents",
                  expectedInstallationID: context.workspace.environmentId,
                  expectedGeneration: base.generation,
                }}
                className={base.workspaceID === baseID ? styles.currentWorkspace : undefined}
              >
                <FolderGit2Icon size={15} />
                <strong>{base.workspace?.name}</strong>
              </Link>
              {base.workspaceID === baseID
                ? contexts.map((c) => (
                    <Link
                      key={c.workspaceID}
                      to="/workspaces"
                      search={{
                        environment: threadRef.environmentId,
                        workspace: baseID,
                        context: c.workspaceID,
                        tab: "agents",
                        expectedInstallationID: context.workspace.environmentId,
                        expectedGeneration: c.generation,
                      }}
                      aria-current={c.workspaceID === contextID ? "page" : undefined}
                    >
                      <GitBranchIcon size={14} />
                      <span>{c.workspace?.lane?.name ?? "Primary"}</span>
                    </Link>
                  ))
                : null}
            </div>
          ))}
          {!bases.some((b) => b.workspaceID === baseID) ? (
            <Link to="/workspaces" search={search}>
              <FolderGit2Icon size={15} />
              {context.workspace.name}
            </Link>
          ) : null}
        </nav>
      </ProductNavigation>
      <div className={styles.main}>
        <header className={styles.header}>
          <div>
            <Link to="/workspaces" search={search}>
              {context.workspace.name}
            </Link>
            <span> / </span>
            <strong>{current}</strong>
          </div>
          <nav aria-label="Views for selected context">
            <Link to="/workspaces" search={{ ...search, tab: "overview" }}>
              <LayersIcon size={14} />
              Overview
            </Link>
            <Link to="/workspaces" search={search} aria-current="page">
              <MessagesSquareIcon size={14} />
              Agents
            </Link>
            <Link
              to="/services"
              search={{
                environment: threadRef.environmentId,
                workspace: contextID,
                expectedInstallationID: context.workspace.environmentId,
                ...(context.checkout.nativeGeneration
                  ? { expectedGeneration: context.checkout.nativeGeneration }
                  : {}),
              }}
            >
              <ServerIcon size={14} />
              Services & runs
            </Link>
            <Link
              to="/recordings"
              search={{
                environment: threadRef.environmentId,
                workspace: contextID,
                expectedInstallationID: context.workspace.environmentId,
                ...(context.checkout.nativeGeneration
                  ? { expectedGeneration: context.checkout.nativeGeneration }
                  : {}),
              }}
            >
              <FilmIcon size={14} />
              Recordings
            </Link>
          </nav>
        </header>
        <div className={styles.body}>
          <aside className={styles.sessions} aria-label="Sessions in selected context">
            {context.requestedThreadId && context.requestedThreadId !== context.session.threadId ? (
              <p className={styles.helperNotice}>
                Viewing a helper task.{" "}
                <Link
                  to="/$environmentId/$threadId"
                  params={{
                    environmentId: threadRef.environmentId,
                    threadId: context.session.threadId,
                  }}
                >
                  Return to its parent session
                </Link>
              </p>
            ) : null}
            <SessionList
              compact
              environmentId={threadRef.environmentId}
              installationID={context.workspace.environmentId}
              workspaceID={contextID}
              generation={context.checkout.nativeGeneration!}
              providers={providers}
              contextLabel={current}
              selectedThreadId={threadRef.threadId}
              showExternal={false}
            />
            <Link className={styles.newSession} to="/workspaces" search={search}>
              + New session
            </Link>
          </aside>
          <div className={styles.conversation}>{children}</div>
        </div>
      </div>
    </div>
  );
}
