import { SessionLauncher } from "./SessionLauncher";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import type { ReactNode } from "react";
import type { ScopedThreadRef } from "@cinderdeck/contracts";
import type { ThreadContextView } from "@cinderdeck/contracts/deckhand/rpc";
import { ProductNavigation } from "./ProductNavigation";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { workspaceView } from "./state";
import { overviewResources, connectedWorkspaceSearch } from "./workspaceNavigation";
import { SessionList } from "./SessionList";
import { useAgentObservation } from "./useAgentObservation";
import { environmentServerConfigsAtom } from "../state/server";
import { deriveProviderInstanceEntries } from "../providerInstances";
import styles from "./connectedShell.module.css";
import native from "./nativeWorkspace.module.css";
import { WorkspaceSections } from "./WorkspaceSections";

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
  const config = useAtomValue(environmentServerConfigsAtom);
  const providers = deriveProviderInstanceEntries(
    config.get(threadRef.environmentId)?.providers ?? [],
  );
  const currentResource = resources.find(
    (resource) =>
      resource.workspaceID === contextID &&
      resource.generation === context.checkout.nativeGeneration,
  );
  const search = connectedWorkspaceSearch(threadRef.environmentId, context, "agents");
  const current =
    context.native?.workspace?.lane?.name ??
    (context.checkout.laneId ? context.feature.title : "Primary");
  return (
    <div className={`${styles.shell} ${native.workspace}`}>
      <ProductNavigation
        hasWorkspaceTree
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
        {treeStale ? (
          <p className={styles.treeHeading} role="status">
            {view ? "Last observed workspace list" : "Workspace list unavailable"}
          </p>
        ) : null}
        <WorkspaceSidebar
          environmentId={threadRef.environmentId}
          installationID={context.workspace.environmentId}
          resources={resources}
          search={search}
        />
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
          <WorkspaceSections search={search} />
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
            {currentResource ? (
              <SessionLauncher
                key={`chat:${threadRef.environmentId}:${context.workspace.environmentId}:${contextID}:${currentResource.generation}`}
                compact
                environmentId={threadRef.environmentId}
                installationID={context.workspace.environmentId}
                resource={currentResource}
                enabled={
                  connected &&
                  currentResource.available &&
                  !currentResource.workspace?.definitionChanged &&
                  !currentResource.workspace?.issues.length
                }
              />
            ) : (
              <Link className={styles.newSession} to="/workspaces" search={search}>
                New chat
              </Link>
            )}
          </aside>
          <div className={styles.conversation}>{children}</div>
        </div>
      </div>
    </div>
  );
}
