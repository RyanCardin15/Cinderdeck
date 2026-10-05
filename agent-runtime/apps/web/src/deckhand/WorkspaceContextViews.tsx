import { lazy, Suspense } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@cinderdeck/contracts";
import type { IntegrationView } from "@cinderdeck/contracts/deckhand/rpc";
import {
  connectedPullRequestSearch,
  type ConnectedPullRequestSearch,
} from "./contextPullRequestScope";
import type { WorkspaceSearch } from "./workspaceNavigation";
import styles from "./workspace.module.css";

const ServicesRuns = lazy(() =>
  import("./ServicesRuns").then((module) => ({ default: module.ServicesRuns })),
);
const Recordings = lazy(() =>
  import("./Recordings").then((module) => ({ default: module.Recordings })),
);
const ContextPullRequests = lazy(() =>
  import("./ContextPullRequests").then((module) => ({ default: module.ContextPullRequests })),
);

// Keep the workspace navigator mounted while loading just the selected tool.
export function WorkspaceContextViews({
  environmentId,
  search,
  selected,
  installationID,
  current,
  resources,
}: {
  environmentId: EnvironmentId;
  search: WorkspaceSearch;
  selected: IntegrationView["resources"][number] | undefined;
  installationID: string | undefined;
  current: boolean;
  resources: IntegrationView["resources"];
}) {
  const navigate = useNavigate();
  if (!selected || !installationID || !current) {
    return (
      <section className={styles["dh-empty"]} role="status">
        <h2>Selected context unavailable</h2>
        <p>Reconnect this computer or select an available workspace or lane to continue.</p>
      </section>
    );
  }
  const selectedTab = search.tab ?? "services";
  const operational =
    selectedTab === "services" ||
    search.tab === "tasks" ||
    search.tab === "workflows" ||
    search.tab === "runs";
  const context = {
    installationID,
    workspaceID: selected.workspaceID,
    generation: selected.generation,
  };
  const key = JSON.stringify([
    environmentId,
    installationID,
    selected.workspaceID,
    selected.generation,
  ]);
  return (
    <section
      aria-label={`${operational ? selectedTab.charAt(0).toUpperCase() + selectedTab.slice(1) : search.tab === "recordings" ? "Recordings" : "Pull requests"} in selected context`}
    >
      <Suspense fallback={<p role="status">Loading selected view…</p>}>
        {operational ? (
          <ServicesRuns
            key={key}
            environmentId={environmentId}
            context={context}
            {...(search.run ? { initialRunID: search.run } : {})}
            workspaceSearch={search}
            repositories={selected.workspace?.repos}
            panel={search.tab as "services" | "tasks" | "workflows" | "runs"}
            onSelectRun={(run) =>
              void navigate({ to: "/workspaces", search: { ...search, tab: "runs", run } })
            }
          />
        ) : search.tab === "recordings" ? (
          <Recordings
            key={key}
            environmentId={environmentId}
            context={context}
            initialRecordingID={search.recording}
            nativeActionsEnabled={current}
            captureContexts={resources
              .filter((resource) => resource.available)
              .map((resource) => ({
                id: resource.workspaceID,
                label: resource.workspace?.name ?? resource.workspaceID,
              }))}
            onSelectRecording={(recording) =>
              void navigate({
                to: "/workspaces",
                search: { ...search, tab: "recordings", recording },
              })
            }
          />
        ) : (
          <ContextPullRequests
            key={key}
            embedded
            scope={{
              ...connectedPullRequestSearch(environmentId, {
                workspaceID: selected.workspace?.lane?.sourceStackID ?? selected.workspaceID,
                contextID: selected.workspaceID,
                installationID,
                generation: selected.generation,
              }),
              ...(search.prHost ? { selectedHost: search.prHost } : {}),
              ...(search.prRepository ? { repository: search.prRepository } : {}),
              ...(search.prNumber !== undefined ? { number: search.prNumber } : {}),
              ...(search.prOffset ? { deckhandOffset: search.prOffset } : {}),
            }}
            onNavigate={(scope: ConnectedPullRequestSearch) => {
              const {
                prHost: _host,
                prRepository: _repository,
                prNumber: _number,
                prOffset: _offset,
                ...base
              } = search;
              void navigate({
                to: "/workspaces",
                search: {
                  ...base,
                  tab: "pull-requests",
                  ...(scope.selectedHost ? { prHost: scope.selectedHost } : {}),
                  ...(scope.repository ? { prRepository: scope.repository } : {}),
                  ...(scope.number !== undefined ? { prNumber: scope.number } : {}),
                  ...(scope.deckhandOffset ? { prOffset: scope.deckhandOffset } : {}),
                },
              });
            }}
          />
        )}
      </Suspense>
    </section>
  );
}
