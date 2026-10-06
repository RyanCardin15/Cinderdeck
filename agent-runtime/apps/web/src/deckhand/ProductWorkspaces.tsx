import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import type { EnvironmentId } from "@cinderdeck/contracts";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { workspaceView } from "./state";
import { overviewResources, type WorkspaceSearch } from "./workspaceNavigation";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { useEnvironmentQuery } from "../state/query";
import styles from "./WorkspaceSidebar.module.css";

/** App-wide views use the same native catalog as the selected workspace view. */
export function ProductWorkspaces({ search }: { search?: WorkspaceSearch | undefined }) {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const environmentId = search?.environment
    ? environments.find((item) => item.environmentId === search.environment)?.environmentId
    : (primary ?? environments[0]?.environmentId);
  return environmentId ? (
    <ConnectedWorkspaces environmentId={environmentId} search={search ?? {}} />
  ) : (
    <section aria-label="Workspaces">
      <div className={styles.heading}>Workspaces</div>
      <p className={styles.notice}>
        {search?.environment ? "Computer unavailable" : "Connect a computer to see workspaces."}
      </p>
      <Link to="/settings/connections" className={styles.notice}>
        Manage connections
      </Link>
    </section>
  );
}

function ConnectedWorkspaces({
  environmentId,
  search,
}: {
  environmentId: EnvironmentId;
  search: WorkspaceSearch;
}) {
  const result = useAtomValue(workspaceView({ environmentId, input: { offset: 0, limit: 50 } }));
  const view = Option.getOrNull(AsyncResult.value(result));
  // The catalog stays subscribed as selection changes. Supplement it with the
  // selected workspace's lanes, including workspaces outside the first page.
  const selected = useEnvironmentQuery(
    search.workspace
      ? workspaceView({
          environmentId,
          input: {
            offset: 0,
            limit: 48,
            selectedWorkspaceID: search.workspace,
            selectedContextID: search.context ?? search.workspace,
            workspacePage: { offset: 0, limit: 50 },
          },
        })
      : null,
  );
  const resources = [
    ...new Map(
      [
        ...overviewResources(view),
        ...overviewResources(
          selected.data?.hello?.installationID === view?.hello?.installationID
            ? selected.data
            : null,
        ),
      ].map((resource) => [resource.workspaceID, resource]),
    ).values(),
  ];
  return (
    <section aria-label="Workspace navigator">
      {view?.hello ? (
        <>
          {result._tag === "Failure" || view.state !== "connected" ? (
            <p className={styles.notice} role="status">
              Last observed workspaces
            </p>
          ) : null}
          <WorkspaceSidebar
            environmentId={environmentId}
            installationID={view.hello.installationID}
            resources={resources}
            search={{ ...search, environment: environmentId }}
          />
        </>
      ) : (
        <>
          <div className={styles.heading}>Workspaces</div>
          <p className={styles.notice} role="status">
            {AsyncResult.isInitial(result) ? "Loading workspaces…" : "Workspace list unavailable"}
          </p>
        </>
      )}
    </section>
  );
}
