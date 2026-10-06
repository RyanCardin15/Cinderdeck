import { WorkspaceSettingsButton, WorkspaceBranchesButton } from "./WorkspaceSettingsButton";
import { SessionLauncher } from "./SessionLauncher";
import { workspaceChatUnavailableReason } from "@cinderdeck/shared/workspaceChat";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { ScopedThreadRef } from "@cinderdeck/contracts";
import type { ThreadContextView } from "@cinderdeck/contracts/deckhand/rpc";
import { ProductNavigation } from "./ProductNavigation";
import { useEnvironmentQuery } from "../state/query";
import { useNavigationSnapshot } from "./useNavigationSnapshot";
import { workspaceView } from "./state";
import { overviewResources, connectedWorkspaceSearch } from "./workspaceNavigation";
import { SessionList } from "./SessionList";
import { useAgentObservation } from "./useAgentObservation";
import { environmentServerConfigsAtom } from "../state/server";
import { deriveProviderInstanceEntries } from "../providerInstances";
import styles from "./connectedShell.module.css";
import native from "./nativeWorkspace.module.css";
import { LaneName } from "./LaneName";
import { WorkspaceSections } from "./WorkspaceSections";

/** Shares the operational navigator around the existing single ChatView. */
export function ConnectedWorkspaceShell({
  context,
  threadRef,
  children,
  stale: suppliedStale = false,
  fallbackSidebar,
  settings = false,
}: {
  context: ThreadContextView | null;
  threadRef: ScopedThreadRef | null;
  fallbackSidebar?: ReactNode;
  settings?: boolean;
  children: ReactNode;
  stale?: boolean;
}) {
  const baseID = context?.workspace.ownerId;
  const contextID = context?.checkout.laneId ?? baseID;
  const query = useEnvironmentQuery(
    threadRef && context
      ? workspaceView({
          environmentId: threadRef.environmentId,
          input: {
            offset: 0,
            limit: 48,
            selectedWorkspaceID: baseID!,
            selectedContextID: contextID!,
            workspacePage: { offset: 0, limit: 50 },
          },
        })
      : null,
  );
  const { value: view, retained } = useNavigationSnapshot(
    threadRef?.environmentId ?? null,
    query.data,
    !query.isSuccess && query.error === null,
  );
  const observationScope = JSON.stringify([
    threadRef?.threadId,
    context?.workspace.environmentId,
    contextID,
    context?.checkout.nativeGeneration,
  ]);
  const contextObservation = useAgentObservation(
    threadRef?.environmentId ?? null,
    observationScope,
    context,
  );
  const workspaceObservation = useAgentObservation(
    threadRef?.environmentId ?? null,
    `${observationScope}:workspaces`,
    query.data,
  );
  const sameInstallation = view?.hello?.installationID === context?.workspace.environmentId;
  const treeStale =
    retained ||
    query.error !== null ||
    workspaceObservation.stale ||
    view?.state !== "connected" ||
    !sameInstallation;
  const stale = suppliedStale || contextObservation.stale || treeStale;
  const connected = !stale && context?.nativeConnection === "connected";
  const resources = overviewResources(sameInstallation ? view : null);
  const config = useAtomValue(environmentServerConfigsAtom);
  const providers = deriveProviderInstanceEntries(
    (threadRef ? config.get(threadRef.environmentId)?.providers : undefined) ?? [],
  );
  const currentResource = resources.find(
    (resource) =>
      resource.workspaceID === contextID &&
      resource.generation === context?.checkout.nativeGeneration,
  );
  const search =
    threadRef && context
      ? connectedWorkspaceSearch(threadRef.environmentId, context, "agents")
      : undefined;
  const current =
    context?.native?.workspace?.lane?.name ??
    (context?.checkout.laneId ? (context.checkout.laneName ?? context.feature.title) : "Primary");
  return (
    <div
      className={`${styles.shell} ${native.workspace}`}
      data-connected-context={context !== null}
    >
      <ProductNavigation
        current={settings ? "settings" : "conversations"}
        {...(search ? { workspaceSearch: search } : {})}
        {...(context
          ? {
              connection: {
                connected,
                label: stale
                  ? "Last observed workspace"
                  : connected
                    ? "Workspace connected"
                    : "Workspace unavailable",
              },
            }
          : {})}
      />
      <div className={styles.main}>
        {context && threadRef && search ? (
          <header className={styles.header}>
            <div>
              <Link
                to="/workspaces"
                search={{
                  environment: threadRef.environmentId,
                  workspace: context.workspace.ownerId,
                  tab: "agents",
                  expectedInstallationID: context.workspace.environmentId,
                }}
              >
                {context.workspace.name}
              </Link>
              <span> / </span>
              <strong>
                {currentResource?.workspace?.lane && view?.hello ? (
                  <LaneName
                    environmentId={threadRef.environmentId}
                    installationID={view.hello.installationID}
                    resource={currentResource}
                    enabled={
                      connected && view.hello.capabilities.includes("operations.lane.update")
                    }
                  />
                ) : (
                  current
                )}
              </strong>
              <WorkspaceBranchesButton
                environmentId={threadRef.environmentId}
                workspaceID={context.checkout.laneId ?? context.workspace.ownerId}
                label={`Switch branch in ${context.workspace.name} / ${current}`}
                enabled={connected && !!currentResource?.workspace?.repos.length}
                showLabel
              />
              <WorkspaceSettingsButton
                environmentId={threadRef.environmentId}
                workspaceID={context.workspace.ownerId}
                label={`Workspace settings for ${context.workspace.name}`}
                enabled={connected}
                showLabel
              />
            </div>
            <WorkspaceSections search={search} />
          </header>
        ) : null}
        <div className={styles.body}>
          <aside
            className={context ? styles.sessions : styles.fallbackSessions}
            aria-label={settings ? "Settings categories" : "Sessions"}
          >
            {context && threadRef && search ? (
              <>
                {context.requestedThreadId &&
                context.requestedThreadId !== context.session.threadId ? (
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
                {currentResource ? (
                  <SessionLauncher
                    key={`chat:${threadRef.environmentId}:${context.workspace.environmentId}:${contextID}:${currentResource.generation}`}
                    compact
                    environmentId={threadRef.environmentId}
                    installationID={context.workspace.environmentId}
                    resource={currentResource}
                    enabled={connected && workspaceChatUnavailableReason(currentResource) === null}
                    disabledReason={workspaceChatUnavailableReason(currentResource) ?? undefined}
                  />
                ) : (
                  <Link className={styles.newSession} to="/workspaces" search={search}>
                    New chat
                  </Link>
                )}
                <SessionList
                  compact
                  environmentId={threadRef.environmentId}
                  installationID={context.workspace.environmentId}
                  workspaceID={context.checkout.laneId ?? context.workspace.ownerId}
                  generation={context.checkout.nativeGeneration!}
                  providers={providers}
                  contextLabel={current}
                  selectedThreadId={threadRef.threadId}
                  showExternal={false}
                />
              </>
            ) : (
              fallbackSidebar
            )}
          </aside>
          <div className={styles.conversation}>{children}</div>
        </div>
      </div>
    </div>
  );
}
