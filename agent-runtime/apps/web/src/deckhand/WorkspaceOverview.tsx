import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { FolderGit2Icon, ArrowRightIcon } from "lucide-react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import type { EnvironmentId } from "@cinderdeck/contracts";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useNavigationSnapshot } from "./useNavigationSnapshot";
import { useAgentObservation } from "./useAgentObservation";
import { workspaceView } from "./state";
import { overviewResources } from "./workspaceNavigation";
import { ProductNavigation } from "./ProductNavigation";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { WorkspaceSections } from "./WorkspaceSections";
import { WorkspaceSessions } from "./WorkspaceSessions";
import { SessionLauncher } from "./SessionLauncher";
import { WorkspaceContextViews } from "./WorkspaceContextViews";
import { NativeWorkspaceTools } from "./NativeWorkspaceTools";
import { WorkspaceRefreshButton } from "./WorkspaceRefreshButton";
import { workspaceChatUnavailableReason } from "@cinderdeck/shared/workspaceChat";
import styles from "./workspace.module.css";
import native from "./nativeWorkspace.module.css";

export function WorkspaceOverview() {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const search = useSearch({ from: "/_chat/workspaces" });
  const environmentId = search.environment
    ? environments.find((item) => item.environmentId === search.environment)?.environmentId
    : (primary ?? environments[0]?.environmentId);
  return environmentId ? (
    <ConnectedWorkspace key={environmentId} environmentId={environmentId} />
  ) : (
    <div className={`${native.workspace} ${styles["dh-shell"]} ${styles["dh-shell-agents"]}`}>
      <ProductNavigation current="workspaces" workspaceSearch={search} />
      <main className={styles["dh-empty"]}>
        <h1>{search.environment ? "Computer unavailable" : "Connect a computer"}</h1>
        <p>Connect a computer to open your workspaces and sessions.</p>
        <Link to="/settings/connections">
          Manage connections <ArrowRightIcon size={16} />
        </Link>
      </main>
    </div>
  );
}

function ConnectedWorkspace({ environmentId }: { environmentId: EnvironmentId }) {
  const search = useSearch({ from: "/_chat/workspaces" });
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const result = useAtomValue(
    workspaceView({
      environmentId,
      input: {
        offset: 0,
        limit: 48,
        ...(search.workspace ? { selectedWorkspaceID: search.workspace } : {}),
        ...(search.context ? { selectedContextID: search.context } : {}),
      },
    }),
  );
  const observed = Option.getOrNull(AsyncResult.value(result));
  const snapshot = useNavigationSnapshot(environmentId, observed, AsyncResult.isInitial(result));
  const view = snapshot.value;
  const observation = useAgentObservation(
    environmentId,
    `workspaces:${search.workspace ?? "catalog"}`,
    observed,
  );
  const resources = overviewResources(view);
  const bases = resources.filter((row) => row.workspace && !row.workspace.lane);
  // Old checkout links remain readable, but workspace navigation always opens its owner.
  const oldContext = resources.find((row) => row.workspaceID === search.context);
  const ownerID =
    oldContext?.workspace?.lane?.sourceStackID ?? search.workspace ?? oldContext?.workspaceID;
  const selected = ownerID ? bases.find((row) => row.workspaceID === ownerID) : undefined;
  const current =
    !snapshot.retained &&
    !observation.stale &&
    result._tag !== "Failure" &&
    view?.state === "connected";
  const sameInstallation =
    !search.expectedInstallationID || search.expectedInstallationID === view?.hello?.installationID;
  const operational = search.tab && !["overview", "agents", "lane-map"].includes(search.tab);
  const tabSearch = {
    environment: environmentId,
    ...(selected
      ? {
          workspace: selected.workspaceID,
          context: selected.workspaceID,
          expectedGeneration: selected.generation,
        }
      : {}),
    ...(view?.hello ? { expectedInstallationID: view.hello.installationID } : {}),
    ...(search.tab ? { tab: search.tab === "lane-map" ? ("agents" as const) : search.tab } : {}),
    ...(search.recording ? { recording: search.recording } : {}),
    ...(search.run ? { run: search.run } : {}),
    ...(search.prOffset !== undefined ? { prOffset: search.prOffset } : {}),
    ...(search.prHost
      ? { prHost: search.prHost, prRepository: search.prRepository, prNumber: search.prNumber }
      : {}),
  };
  const toolContext = oldContext ?? selected;
  const operationalSearch = toolContext
    ? {
        ...tabSearch,
        context: toolContext.workspaceID,
        expectedGeneration: search.expectedGeneration ?? toolContext.generation,
        ...(search.expectedInstallationID
          ? { expectedInstallationID: search.expectedInstallationID }
          : {}),
      }
    : tabSearch;
  const toolCurrent =
    current &&
    sameInstallation &&
    (!search.expectedGeneration || search.expectedGeneration === toolContext?.generation);
  return (
    <div className={`${native.workspace} ${styles["dh-shell"]} ${styles["dh-shell-agents"]}`}>
      <ProductNavigation
        current={
          operational
            ? search.tab === "recordings"
              ? "recordings"
              : search.tab === "pull-requests"
                ? "pull-requests"
                : "services"
            : search.tab === "overview"
              ? "workspaces"
              : "conversations"
        }
        hasWorkspaceTree
        workspaceSearch={tabSearch}
      >
        {environments.length > 1 ? (
          <label className={styles["dh-field-label"]}>
            Computer
            <select
              value={environmentId}
              onChange={(event) =>
                void navigate({ to: "/workspaces", search: { environment: event.target.value } })
              }
            >
              {environments.map((item) => (
                <option key={item.environmentId} value={item.environmentId}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <WorkspaceSidebar
          environmentId={environmentId}
          installationID={view?.hello?.installationID ?? "unconnected"}
          resources={resources}
          search={tabSearch}
        />
      </ProductNavigation>
      <main className={styles["dh-main"]} aria-labelledby="dh-title">
        <header className={styles["dh-header"]}>
          <div className={native.heading}>
            <span className={native.featureIcon} aria-hidden>
              <FolderGit2Icon size={20} />
            </span>
            <div>
              <h1 id="dh-title">{selected?.workspace?.name ?? "Workspaces"}</h1>
              <p className={native.path}>
                {selected?.workspace?.root ??
                  selected?.workspace?.repos[0]?.path ??
                  "Open a workspace to continue a session."}
              </p>
            </div>
          </div>
          <NativeWorkspaceTools
            environmentId={environmentId}
            enabled={current && sameInstallation}
            workspaceID={selected?.workspaceID}
            sourceWorkspaceID={selected?.workspaceID}
            header={!!selected}
          />
        </header>
        {selected ? <WorkspaceSections search={tabSearch} /> : null}
        {result._tag === "Failure" || (view && !current) ? (
          <p role="status" className={styles["dh-status-error"]}>
            Workspace tools are unavailable. Your saved sessions remain accessible.
          </p>
        ) : null}
        {!sameInstallation ? (
          <p role="alert">
            This link belongs to a different Cinderdeck installation. Choose a workspace to
            continue.
          </p>
        ) : null}
        {ownerID && !selected ? (
          <section className={styles["dh-empty"]} role="status">
            <h2>Workspace unavailable</h2>
            <p>Select another workspace from the sidebar.</p>
          </section>
        ) : selected && view?.hello ? (
          operational ? (
            <WorkspaceContextViews
              environmentId={environmentId}
              search={operationalSearch}
              selected={toolContext}
              installationID={view.hello.installationID}
              current={toolCurrent}
              resources={resources}
            />
          ) : (
            <section aria-label="Workspace sessions">
              <SessionLauncher
                key={`${environmentId}:${view.hello.installationID}:${selected.workspaceID}:${selected.generation}`}
                environmentId={environmentId}
                installationID={view.hello.installationID}
                resource={selected}
                compact
                enabled={
                  current && sameInstallation && workspaceChatUnavailableReason(selected) === null
                }
                disabledReason={workspaceChatUnavailableReason(selected) ?? undefined}
                editReviewSkill={search.editReviewSkill === true}
                autoOpen={search.editReviewSkill === true}
              />
              <WorkspaceSessions
                environmentId={environmentId}
                installationID={view.hello.installationID}
                resource={selected}
                resources={resources}
              />
            </section>
          )
        ) : (
          <section className={styles["dh-list"]} aria-label="Workspaces">
            {!view ? (
              <p role="status">
                {AsyncResult.isInitial(result)
                  ? "Loading workspaces…"
                  : "Workspace list unavailable"}
              </p>
            ) : null}
            {bases.map((resource) => (
              <Link
                key={resource.workspaceID}
                className={styles["dh-button"]}
                to="/workspaces"
                search={{
                  environment: environmentId,
                  workspace: resource.workspaceID,
                  tab: "agents",
                }}
              >
                <FolderGit2Icon size={18} />
                {resource.workspace?.name}
                <ArrowRightIcon size={14} />
              </Link>
            ))}
            {view && !bases.length ? (
              <div className={styles["dh-empty"]}>
                <h2>Add your first workspace</h2>
                <p>Choose a project folder, then open a session to get started.</p>
              </div>
            ) : null}
          </section>
        )}
        <WorkspaceRefreshButton environmentId={environmentId} />
      </main>
    </div>
  );
}
