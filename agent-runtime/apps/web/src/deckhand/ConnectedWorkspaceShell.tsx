import type { ReactNode } from "react";
import type { ScopedThreadRef } from "@cinderdeck/contracts";
import type { ThreadContextView } from "@cinderdeck/contracts/deckhand/rpc";
import { ProductNavigation } from "./ProductNavigation";
import { useEnvironmentQuery } from "../state/query";
import { useNavigationSnapshot } from "./useNavigationSnapshot";
import { workspaceView } from "./state";
import { overviewResources, connectedWorkspaceSearch } from "./workspaceNavigation";
import { useAgentObservation } from "./useAgentObservation";
import styles from "./connectedShell.module.css";
import native from "./nativeWorkspace.module.css";

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
  const resources = overviewResources(sameInstallation ? view : null);
  const currentResource = resources.find(
    (resource) => resource.workspaceID === baseID && resource.available,
  );
  const connected = !stale && currentResource?.available === true;
  const search =
    threadRef && context
      ? connectedWorkspaceSearch(threadRef.environmentId, context, "agents")
      : undefined;
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
        <div className={styles.body} data-settings={settings && !!fallbackSidebar}>
          {settings && fallbackSidebar ? (
            <aside className={styles.fallbackSessions} aria-label="Settings categories">
              {fallbackSidebar}
            </aside>
          ) : null}
          <div className={styles.conversation}>{children}</div>
        </div>
      </div>
    </div>
  );
}
