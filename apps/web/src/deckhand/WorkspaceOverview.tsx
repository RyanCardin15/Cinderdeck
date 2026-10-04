import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  GitBranchIcon,
  PlusIcon,
  ArrowRightIcon,
  RefreshCwIcon,
  FolderGit2Icon,
  ActivityIcon,
  XIcon,
  CircleDotIcon,
  ChevronRightIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import * as Option from "effect/Option";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { runtime } from "../lib/runtime";
import { connectedPullRequestSearch } from "./contextPullRequestScope";
import { AsyncResult } from "effect/unstable/reactivity";
import type { EnvironmentId } from "@t3tools/contracts";
import type { IntegrationView, ManagedContextView } from "@t3tools/contracts/deckhand/rpc";
import type { IntegrationOperationReceipt } from "@t3tools/contracts/deckhand/integration";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  overviewPageSelection,
  overviewResources,
  overviewWorkspaceContexts,
  savedWorkspaceMatches,
} from "./workspaceNavigation";
import { SessionList } from "./SessionList";
import { WorkspaceFilters } from "./WorkspaceFilters";
import { LaneLifecycleControls } from "./LaneLifecycleControls";
import {
  defaultWorkspaceFilters,
  selectWorkspaceContexts,
  type WorkspaceFilterValue,
} from "./workspaceContextFilters";
import { useAgentObservation } from "./useAgentObservation";
import { agentExecutionLabel, agentProviderLabel } from "./agentPresentation";
import { environmentServerConfigsAtom } from "../state/server";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { SessionLauncher } from "./SessionLauncher";
import { ProductNavigation } from "./ProductNavigation";
import {
  workspaceView,
  managedContextsView,
  refreshWorkspaces,
  submitOperation,
  inspectOperation,
  recentOperations,
} from "./state";
import type { RecordingContextOverview } from "@t3tools/contracts/deckhand/recordingsRpc";
import { recordingOverview } from "./recordingState";
import { RecordingThumbnail } from "./RecordingThumbnail";
import styles from "./workspace.module.css";

type Resource = IntegrationView["resources"][number];
const label = (state: IntegrationView["state"]) =>
  ({
    connecting: "Connecting to Cinderdeck",
    connected: "Cinderdeck connected",
    reconnecting: "Reconnecting to Cinderdeck",
    unavailable: "Cinderdeck unavailable",
    incompatible: "Cinderdeck needs attention",
    identity_changed: "Connection identity changed",
    unauthorized: "Connection refused",
    unsupported: "Cinderdeck requires macOS",
  })[state];
const actionable = (resource: Resource) =>
  resource.available &&
  resource.workspace !== null &&
  resource.workspace !== undefined &&
  !resource.workspace.issues.length &&
  !resource.workspace.definitionChanged;
const terminal = (receipt: IntegrationOperationReceipt) =>
  !["pending", "running"].includes(receipt.state);
export function WorkspaceOverview() {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const search = useSearch({ from: "/_chat/workspaces" });
  const navigate = useNavigate();
  const environmentId = search.environment
    ? environments.find((item) => item.environmentId === search.environment)?.environmentId
    : (primary ?? environments[0]?.environmentId);
  const select = (id: EnvironmentId | null) => {
    void navigate({ to: "/workspaces", search: id ? { environment: id } : {} });
  };
  return environmentId ? (
    <ConnectedWorkspace
      key={environmentId}
      environmentId={environmentId}
      environments={environments}
      selectEnvironment={select}
    />
  ) : (
    <main className={styles["dh-empty"]}>
      <h1>
        {search.environment ? "Execution computer unavailable" : "Choose an execution computer"}
      </h1>
      <p>Connect a computer to browse its workspaces.</p>
      <Link to="/settings/connections">
        Manage connections <ArrowRightIcon size={16} />
      </Link>
    </main>
  );
}

function ConnectedWorkspace({
  environmentId,
  environments,
  selectEnvironment,
}: {
  environmentId: EnvironmentId;
  environments: ReturnType<typeof useEnvironments>["environments"];
  selectEnvironment: (id: EnvironmentId | null) => void;
}) {
  const search = useSearch({ from: "/_chat/workspaces" });
  const navigate = useNavigate();
  const agentMode = search.tab === "agents";
  const selectedBaseRef = useRef<string | null>(search.workspace ?? null);
  const mountedRef = useRef(true);
  const selectionVersionRef = useRef(
    JSON.stringify([search.workspace, search.context, search.tab]),
  );
  useEffect(() => {
    selectionVersionRef.current = JSON.stringify([search.workspace, search.context, search.tab]);
  }, [search.workspace, search.context, search.tab, selectionVersionRef]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const setWorkspaceID = (workspace: string) => {
    selectedBaseRef.current = workspace;
    selectionVersionRef.current = JSON.stringify([workspace, undefined, search.tab]);
    void navigate({
      to: "/workspaces",
      search: { environment: environmentId, workspace, ...(search.tab ? { tab: search.tab } : {}) },
    });
  };
  const setSelectedID = useCallback(
    (context: string | null) => {
      selectionVersionRef.current = JSON.stringify([
        search.workspace,
        context ?? undefined,
        search.tab,
      ]);
      void navigate({
        to: "/workspaces",
        search: context
          ? {
              environment: environmentId,
              ...(search.workspace ? { workspace: search.workspace } : {}),
              context,
              ...(search.tab ? { tab: search.tab } : {}),
            }
          : search.workspace
            ? {
                environment: environmentId,
                workspace: search.workspace,
                ...(search.tab ? { tab: search.tab } : {}),
              }
            : { environment: environmentId, ...(search.tab ? { tab: search.tab } : {}) },
      });
    },
    [navigate, search, environmentId],
  );
  const workspaceID = search.workspace ?? null;
  const selectedID = search.context ?? null;
  const [offset, setOffset] = useState(0);
  const pageWorkspaceID = workspaceID ?? selectedID ?? `catalog:${offset}`;
  const [workspacePage, setWorkspacePage] = useState<{
    workspaceID: string | null;
    offset: number;
  }>({ workspaceID: pageWorkspaceID, offset: 0 });
  const workspaceOffset = workspacePage.workspaceID === pageWorkspaceID ? workspacePage.offset : 0;
  const pageInput = overviewPageSelection(search, offset, workspaceOffset);
  const result = useAtomValue(workspaceView({ environmentId, input: pageInput }));
  const view = Option.getOrNull(AsyncResult.value(result));
  const nativeObservation = useAgentObservation(environmentId, JSON.stringify(pageInput), view);
  const nativeCurrent =
    result._tag !== "Failure" && !nativeObservation.stale && view?.state === "connected";
  const connectionLabel = nativeObservation.stale
    ? nativeObservation.reconnecting
      ? "Reconnecting to this computer"
      : "Computer connection unavailable"
    : view
      ? label(view.state)
      : "Connecting…";
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const providers = deriveProviderInstanceEntries(
    serverConfigs.get(environmentId)?.providers ?? [],
  );
  const [filters, setFilters] = useState<WorkspaceFilterValue>(() => ({
    ...defaultWorkspaceFilters,
  }));
  const [branch, setBranch] = useState("");
  const [creating, setCreating] = useState(false);
  const [featureCreating, setFeatureCreating] = useState(false);
  const [featurePending, setFeaturePending] = useState(false);
  const newFeatureButton = useRef<HTMLButtonElement>(null);
  const closeFeature = useCallback(() => {
    setFeatureCreating(false);
    newFeatureButton.current?.focus();
  }, []);
  const [busy, setBusy] = useState(false);
  const [lifecyclePending, setLifecyclePending] = useState(false);
  const [operation, setOperation] = useState<{
    key: string;
    workspaceID: string;
    installationID: string;
    receipt: IntegrationOperationReceipt | null;
    refused: boolean;
    message: string | null;
  } | null>(null);
  const refresh = useAtomCommand(refreshWorkspaces, { reportFailure: false });
  const submit = useAtomCommand(submitOperation, { reportFailure: false });
  const inspect = useAtomCommand(inspectOperation, { reportFailure: false });
  const recent = useAtomCommand(recentOperations, { reportFailure: false });
  const [recoveredScope, setRecoveredScope] = useState<string | null>(null);
  const [recoveryErrorScope, setRecoveryErrorScope] = useState<string | null>(null);
  const recordingSummary = useAtomCommand(recordingOverview, { reportFailure: false });
  const [recordingSummaries, setRecordingSummaries] =
    useState<ReadonlyArray<RecordingContextOverview> | null>(null);
  const [recordingSummaryError, setRecordingSummaryError] = useState(false);
  useEffect(() => {
    if (view?.state !== "connected" || !view.hello) return;
    let active = true;
    void recordingSummary({
      environmentId,
      input: {
        installationID: view.hello.installationID,
        contexts: overviewResources(view).map((resource) => ({
          workspaceID: resource.workspaceID,
          generation: resource.generation,
        })),
      },
    }).then((response) => {
      if (!active) return;
      setRecordingSummaryError(response._tag !== "Success");
      if (response._tag === "Success") setRecordingSummaries(response.value);
    });
    return () => {
      active = false;
    };
  }, [view, environmentId, recordingSummary]);
  const resources = overviewResources(view);
  const agentContexts = resources
    .map((resource) => ({ workspaceID: resource.workspaceID, generation: resource.generation }))
    .sort(
      (left, right) =>
        left.workspaceID.localeCompare(right.workspaceID) || left.generation - right.generation,
    );
  const agentScope = JSON.stringify([view?.hello?.installationID, agentContexts]);
  const contextResult = useAtomValue(
    managedContextsView({
      environmentId,
      input: {
        installationID: view?.hello?.installationID ?? "unconnected",
        contexts: agentContexts,
      },
    }),
  );
  const summaries = Option.getOrNull(AsyncResult.value(contextResult));
  const agentObservation = useAgentObservation(environmentId, agentScope, summaries);
  const agentsUnavailable =
    contextResult._tag === "Failure" ||
    agentObservation.stale ||
    nativeObservation.stale ||
    result._tag === "Failure" ||
    (view !== null && view.state !== "connected");
  const summaryFor = (resource: Resource) =>
    summaries?.find(
      (item) =>
        item.workspaceID === resource.workspaceID && item.generation === resource.generation,
    );
  const bases = resources.filter((resource) => !resource.workspace?.lane && resource.available);
  const activeBase = workspaceID
    ? bases.find((resource) => resource.workspaceID === workspaceID)
    : bases[0];
  useEffect(() => {
    selectedBaseRef.current = activeBase?.workspaceID ?? null;
  }, [activeBase?.workspaceID, selectedBaseRef]);
  const contexts = activeBase
    ? overviewWorkspaceContexts(view, activeBase.workspaceID)
    : workspaceID
      ? []
      : resources;
  const lanes = contexts.filter((resource) => resource.workspace?.lane);
  const filterOptions = {
    nativeUnavailable: !nativeCurrent,
    agentsUnavailable,
    providers,
    activity: view?.activity,
  };
  const visible = selectWorkspaceContexts(contexts, summaries, filters, filterOptions).resources;
  const needsAttention = (resource: Resource) =>
    selectWorkspaceContexts(
      [resource],
      summaries,
      { ...defaultWorkspaceFilters, activity: "attention" },
      filterOptions,
    ).matchedCount > 0;
  const selectedCandidate = selectedID
    ? contexts.find((resource) => resource.workspaceID === selectedID)
    : activeBase;
  const savedContextChanged =
    view?.state === "connected" &&
    !savedWorkspaceMatches(search, view.hello?.installationID, selectedCandidate?.generation);
  const selected = savedContextChanged ? undefined : selectedCandidate;
  const lifecycleRecoveryWorkspaceID =
    selected?.workspace?.lane && view?.hello?.capabilities.includes("operations.receipts")
      ? selected.workspaceID
      : null;
  const lifecycleRecoveryInstallationID = lifecycleRecoveryWorkspaceID
    ? view?.hello?.installationID
    : null;
  const recoveryScope = JSON.stringify([
    environmentId,
    search.workspace,
    search.context,
    search.expectedInstallationID,
    search.expectedGeneration,
    lifecycleRecoveryWorkspaceID,
    lifecycleRecoveryInstallationID,
  ]);
  const rootOwnsRecovery =
    operation !== null &&
    !operation.refused &&
    (!operation.receipt ||
      ["pending", "running", "unknown_outcome"].includes(operation.receipt.state));
  const settledOperationKey = rootOwnsRecovery ? null : operation?.key;
  const recovered = recoveredScope === recoveryScope || rootOwnsRecovery;
  const recoveryError = recoveryErrorScope === recoveryScope;
  useEffect(() => {
    if (
      recoveredScope === recoveryScope ||
      rootOwnsRecovery ||
      recoveryError ||
      view?.state !== "connected"
    )
      return;
    let disposed = false;
    void recent({ environmentId, input: {} }).then((response) => {
      if (disposed) return;
      if (response._tag !== "Success") {
        setRecoveryErrorScope(recoveryScope);
        return;
      }
      setRecoveryErrorScope(null);
      const unresolved = response.value.find(
        (record) =>
          !record.refused &&
          record.input.operationKey !== settledOperationKey &&
          !(
            lifecycleRecoveryWorkspaceID &&
            ["lane.setup", "lane.release", "lane.remove"].includes(record.input.method) &&
            record.input.workspaceID === lifecycleRecoveryWorkspaceID &&
            record.input.installationID === lifecycleRecoveryInstallationID
          ) &&
          (!record.receipt ||
            ["pending", "running", "unknown_outcome"].includes(record.receipt.state)),
      );
      if (unresolved)
        setOperation({
          key: unresolved.input.operationKey,
          workspaceID: unresolved.input.workspaceID,
          installationID: unresolved.input.installationID,
          receipt: unresolved.receipt,
          refused: false,
          message:
            "Recovered a previously submitted operation. Check its result before taking another action.",
        });
      setRecoveredScope(recoveryScope);
    });
    return () => {
      disposed = true;
    };
  }, [
    environmentId,
    recent,
    recoveredScope,
    recoveryScope,
    rootOwnsRecovery,
    settledOperationKey,
    view?.state,
    recoveryError,
    lifecycleRecoveryWorkspaceID,
    lifecycleRecoveryInstallationID,
  ]);
  const nativeActionsEnabled =
    !savedContextChanged &&
    nativeCurrent &&
    !busy &&
    recovered &&
    !(
      operation?.receipt &&
      !operation.refused &&
      !["succeeded", "failed"].includes(operation.receipt.state)
    ) &&
    !(operation && !operation.refused && operation.receipt === null);
  const enabled = nativeActionsEnabled && !lifecyclePending;
  const createdLaneID =
    operation?.receipt?.result?.workspace?.id ?? operation?.receipt?.result?.createdWorkspaceID;
  const tabSearch = {
    ...search,
    environment: environmentId,
    ...(activeBase ? { workspace: activeBase.workspaceID } : {}),
    ...(selected
      ? {
          context: selected.workspaceID,
          expectedGeneration: selected.generation,
          ...(view?.hello ? { expectedInstallationID: view.hello.installationID } : {}),
        }
      : {}),
  };
  const contextLinkSearch = {
    environment: environmentId,
    ...(selected || selectedID || activeBase
      ? { workspace: selected?.workspaceID ?? selectedID ?? activeBase!.workspaceID }
      : {}),
    ...(search.expectedGeneration !== undefined
      ? { expectedGeneration: search.expectedGeneration }
      : selected
        ? { expectedGeneration: selected.generation }
        : {}),
    ...(search.expectedInstallationID
      ? { expectedInstallationID: search.expectedInstallationID }
      : view?.hello
        ? { expectedInstallationID: view.hello.installationID }
        : {}),
  };
  const selectedName = selected?.workspace?.lane
    ? `Lane · ${selected.workspace.lane.name}`
    : "Primary checkout";
  const managedTotal = contexts.reduce(
    (sum, resource) => sum + (summaryFor(resource)?.total ?? 0),
    0,
  );
  const canCreateFeature = [
    "operations.lane.create",
    "operations.lane.create.repositoryRefs",
    "operations.lane.create.managedWriter",
    "operations.receipts.wait",
    "checkout.reservations",
  ].every((capability) => view?.hello?.capabilities.includes(capability));
  const reconcile = useCallback(async () => {
    if (!operation) return;
    const selectionVersion = selectionVersionRef.current;
    const response = await inspect({ environmentId, input: { operationKey: operation.key } });
    if (!mountedRef.current) return;
    if (response._tag === "Success") {
      const createdID =
        response.value.result?.workspace?.id ?? response.value.result?.createdWorkspaceID;
      if (
        response.value.method === "lane.create" &&
        response.value.state === "succeeded" &&
        createdID &&
        selectedBaseRef.current === operation.workspaceID &&
        selectionVersionRef.current === selectionVersion
      )
        setSelectedID(createdID);
      setOperation((current) =>
        current?.key === operation.key
          ? { ...current, receipt: response.value, message: null }
          : current,
      );
    } else
      setOperation((current) =>
        current?.key === operation.key
          ? {
              ...current,
              message: "The operation could not be reconciled. Its outcome remains unknown.",
            }
          : current,
      );
  }, [
    operation,
    inspect,
    environmentId,
    setSelectedID,
    selectedBaseRef,
    selectionVersionRef,
    mountedRef,
  ]);
  useEffect(() => {
    if (!operation?.receipt || terminal(operation.receipt)) return;
    const timer = window.setTimeout(() => {
      void reconcile();
    }, 800);
    return () => window.clearTimeout(timer);
  }, [operation, reconcile]);
  const run = async (
    target: Resource,
    method: "lane.create" | "services.start" | "services.stop" | "services.restart",
  ) => {
    if (!view?.hello || !enabled || !actionable(target)) return;
    const key = await runtime.runPromise(
      Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
    );
    setBusy(true);
    setOperation({
      key,
      workspaceID: target.workspaceID,
      installationID: view.hello.installationID,
      receipt: null,
      refused: false,
      message: null,
    });
    const response = await submit({
      environmentId,
      input: {
        operationKey: key,
        installationID: view.hello.installationID,
        workspaceID: target.workspaceID,
        generation: target.generation,
        revision: target.revision,
        method,
        arguments:
          method === "lane.create"
            ? { workspace: target.workspaceID, branch: branch.trim(), start: false, setup: false }
            : { workspace: target.workspaceID },
      },
    });
    setBusy(false);
    if (response._tag === "Success") {
      setOperation({
        key,
        workspaceID: target.workspaceID,
        installationID: view.hello.installationID,
        receipt: response.value,
        refused: false,
        message: null,
      });
      if (method === "lane.create") {
        setCreating(false);
        setBranch("");
      }
    } else {
      const records = await recent({ environmentId, input: {} });
      const record =
        records._tag === "Success"
          ? records.value.find((item) => item.input.operationKey === key)
          : undefined;
      setOperation({
        key,
        workspaceID: target.workspaceID,
        installationID: view.hello.installationID,
        receipt: null,
        refused: record?.refused ?? false,
        message: record?.refused
          ? `Cinderdeck refused this operation (${record.error?.code ?? record.error?.reason}). Refresh this context before trying again.`
          : "The response was lost or refused. Check this operation before trying another action.",
      });
    }
  };
  return (
    <div className={styles["dh-shell"]}>
      <ProductNavigation
        current="workspaces"
        connection={{
          label: connectionLabel,
          connected: nativeCurrent,
        }}
      >
        <label className={styles["dh-field-label"]} htmlFor="dh-environment">
          Execution computer
        </label>
        <select
          id="dh-environment"
          value={environmentId}
          onChange={(event) =>
            selectEnvironment(
              environments.find((item) => item.environmentId === event.target.value)
                ?.environmentId ?? null,
            )
          }
        >
          {environments.map((item) => (
            <option key={item.environmentId} value={item.environmentId}>
              {item.label}
            </option>
          ))}
        </select>
        <div className={styles["dh-tree-heading"]}>Workspaces</div>
        <nav className={styles["dh-workspace-tree"]} aria-label="Workspaces and lanes">
          {bases.map((base) => (
            <div key={base.workspaceID}>
              <button
                className={
                  base.workspaceID === activeBase?.workspaceID ? styles["dh-tree-current"] : ""
                }
                aria-pressed={base.workspaceID === activeBase?.workspaceID}
                onClick={() => {
                  setWorkspaceID(base.workspaceID);
                  setFeatureCreating(false);
                  setCreating(false);
                }}
              >
                <FolderGit2Icon size={16} />
                <span>{base.workspace?.name}</span>
              </button>
              {base.workspaceID === activeBase?.workspaceID
                ? contexts.map((context) => (
                    <button
                      key={context.workspaceID}
                      className={styles["dh-tree-lane"]}
                      aria-current={
                        selected?.workspaceID === context.workspaceID ? "true" : undefined
                      }
                      onClick={() => setSelectedID(context.workspaceID)}
                    >
                      <GitBranchIcon size={14} />
                      <span>{context.workspace?.lane?.name ?? "Primary checkout"}</span>
                      {needsAttention(context) ? (
                        <CircleDotIcon size={10} className={styles["dh-attention-dot"]} />
                      ) : null}
                    </button>
                  ))
                : null}
            </div>
          ))}
        </nav>
      </ProductNavigation>
      <main className={styles["dh-main"]} aria-labelledby="dh-title">
        <header className={styles["dh-header"]}>
          <div>
            <div className={styles["dh-eyebrow"]}>
              Workspaces <span>/</span> {activeBase?.workspace?.name ?? "This computer"}
            </div>
            <h1 id="dh-title">{activeBase?.workspace?.name ?? "Workspaces"}</h1>
            <p>
              {view?.workspaceContexts &&
              view.workspaceContexts.workspaceID === activeBase?.workspaceID
                ? view.workspaceContexts.laneCount
                : lanes.length}{" "}
              lanes <span>·</span>{" "}
              {summaries
                ? `${managedTotal} managed ${managedTotal === 1 ? "agent" : "agents"}${agentsUnavailable ? " · last observed" : ""}` +
                  (view?.workspaceContexts &&
                  view.workspaceContexts.total > view.workspaceContexts.resources.length
                    ? " on this page"
                    : "")
                : agentsUnavailable
                  ? "Agents unavailable"
                  : "Loading agents…"}
              {summaries ? (
                <>
                  <span> · </span>
                  {contexts.some(
                    (resource) =>
                      !summaryFor(resource)?.externalSessions ||
                      summaryFor(resource)?.externalSessions?.unavailable,
                  )
                    ? "External registrations unavailable"
                    : `${contexts.reduce((sum, resource) => sum + (summaryFor(resource)?.externalSessions?.activeCount ?? 0), 0)} reported external${agentsUnavailable ? " · last observed" : ""}`}
                </>
              ) : null}
            </p>
          </div>
          <div className={styles["dh-inspector-actions"]}>
            <button
              ref={newFeatureButton}
              className={`${styles["dh-button"]} ${styles["dh-accent"]}`}
              disabled={
                !enabled ||
                !activeBase ||
                !actionable(activeBase) ||
                featurePending ||
                !canCreateFeature
              }
              onClick={() => {
                setCreating(false);
                setFeatureCreating(true);
              }}
            >
              <PlusIcon size={17} />
              New feature
            </button>
            <button
              className={styles["dh-button"]}
              disabled={
                !enabled ||
                featurePending ||
                featureCreating ||
                !activeBase ||
                !actionable(activeBase) ||
                !view?.hello?.capabilities.includes("operations.lane.create")
              }
              onClick={() => setCreating(true)}
            >
              <PlusIcon size={17} />
              New lane
            </button>
          </div>
        </header>
        <div className={styles["dh-tabs"]}>
          <Link
            to="/workspaces"
            search={{ ...tabSearch, tab: "overview" }}
            aria-current={!agentMode ? "page" : undefined}
            className={!agentMode ? styles["dh-tab-current"] : undefined}
          >
            Overview
          </Link>
          <Link
            to="/workspaces"
            search={{ ...tabSearch, tab: "agents" }}
            aria-current={agentMode ? "page" : undefined}
            className={agentMode ? styles["dh-tab-current"] : undefined}
          >
            Agents
          </Link>
          <Link
            to="/pull-requests"
            search={
              selected && view?.hello
                ? connectedPullRequestSearch(
                    environmentId,
                    {
                      workspaceID:
                        activeBase?.workspaceID ??
                        selected.workspace?.lane?.sourceStackID ??
                        selected.workspaceID,
                      contextID: selected.workspaceID,
                      installationID: view.hello.installationID,
                      generation: selected.generation,
                    },
                    agentMode ? "agents" : "overview",
                  )
                : {
                    involvement: "all",
                    state: "all",
                    environmentId,
                    ...(search.context || search.workspace
                      ? {
                          deckhandWorkspace: search.workspace ?? search.context,
                          deckhandContext: search.context ?? search.workspace,
                          ...(search.expectedGeneration !== undefined
                            ? { deckhandGeneration: search.expectedGeneration }
                            : {}),
                          ...(search.expectedInstallationID
                            ? { deckhandInstallationID: search.expectedInstallationID }
                            : {}),
                          deckhandTab: agentMode ? ("agents" as const) : ("overview" as const),
                        }
                      : {}),
                  }
            }
          >
            Pull requests
          </Link>
          <Link to="/recordings" search={contextLinkSearch}>
            Recordings
          </Link>
          <Link to="/services" search={contextLinkSearch}>
            Services
          </Link>
        </div>
        <div className={styles["dh-toolbar"]}>
          <label>
            Workspace{" "}
            <select
              value={activeBase?.workspaceID ?? ""}
              onChange={(event) => {
                setWorkspaceID(event.target.value);
                setFeatureCreating(false);
                setCreating(false);
              }}
            >
              {!activeBase ? (
                <option value="" disabled>
                  Choose an available workspace
                </option>
              ) : null}
              {bases.map((resource) => (
                <option key={resource.workspaceID} value={resource.workspaceID}>
                  {resource.workspace?.name}
                </option>
              ))}
            </select>
          </label>
          {agentMode ? (
            <label>
              Context{" "}
              <select
                value={selected?.workspaceID ?? ""}
                onChange={(event) => setSelectedID(event.target.value)}
              >
                {!selected ? (
                  <option value="" disabled>
                    Choose an available context
                  </option>
                ) : null}
                {contexts.map((resource) => (
                  <option key={resource.workspaceID} value={resource.workspaceID}>
                    {resource.workspace?.lane?.name ?? "Primary checkout"}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            className={styles["dh-icon-button"]}
            aria-label="Refresh workspaces"
            onClick={() => {
              void refresh({ environmentId, input: {} });
            }}
          >
            <RefreshCwIcon size={16} />
          </button>
        </div>
        {!agentMode ? (
          <WorkspaceFilters
            value={filters}
            onChange={setFilters}
            resources={contexts}
            summaries={summaries}
            loading={!view}
            totalContextCount={view?.workspaceContexts?.total ?? contexts.length}
            {...filterOptions}
          />
        ) : null}
        {savedContextChanged ? (
          <div role="alert" className={styles["dh-status-error"]}>
            This saved context belongs to an earlier lane or Cinderdeck installation. Its actions
            are unavailable. Choose an available context to inspect its current work.
          </div>
        ) : null}
        {view?.state === "connected" &&
        !savedContextChanged &&
        ((workspaceID && !activeBase) || (selectedID && !selected)) ? (
          <div role="status" className={styles["dh-status-error"]}>
            The selected workspace or lane is unavailable on this computer. Choose an available
            context to continue.
          </div>
        ) : null}
        {result._tag === "Failure" ? (
          <div role="alert" className={styles["dh-status-error"]}>
            This computer could not provide workspace data. Check its connection and try refreshing.
          </div>
        ) : null}
        {nativeObservation.stale && view?.state === "connected" ? (
          <div role="status" className={styles["dh-status-error"]}>
            <strong>{connectionLabel}</strong>
            <p>
              Showing last observed workspace and agent details. Actions resume after fresh context
              is verified.
            </p>
          </div>
        ) : null}
        {view && view.state !== "connected" ? (
          <div role="status" className={styles["dh-status-error"]}>
            <strong>{label(view.state)}</strong>
            <p>
              {view.resources.length
                ? "Showing the last observed workspaces. Actions are unavailable until the connection is verified."
                : "Open Cinderdeck on this computer to connect its workspaces. Agent conversations remain available independently."}
            </p>
            {view.error ? <code>{view.error.code ?? view.error.reason}</code> : null}
          </div>
        ) : null}
        {!view && result._tag !== "Failure" ? (
          <div className={styles["dh-empty"]}>
            <h2>Loading workspaces</h2>
            <p>Waiting for this computer’s workspace catalog.</p>
          </div>
        ) : null}
        {activeBase && view?.hello ? (
          <SessionLauncher
            key={`create:${environmentId}:${view.hello.installationID}:${activeBase.workspaceID}`}
            environmentId={environmentId}
            installationID={view.hello.installationID}
            resource={activeBase}
            enabled={enabled && actionable(activeBase) && canCreateFeature}
            creation={{
              visible: featureCreating,
              onClose: closeFeature,
              onLane: setSelectedID,
              onPending: setFeaturePending,
            }}
          />
        ) : null}
        {creating && activeBase ? (
          <form
            className={styles["dh-create"]}
            onSubmit={(event) => {
              event.preventDefault();
              void run(activeBase, "lane.create");
            }}
          >
            <label htmlFor="dh-branch">New lane branch</label>
            <div>
              <input
                id="dh-branch"
                autoFocus
                required
                maxLength={160}
                placeholder="fix/payment-retry"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
              />
              <button
                className={styles["dh-button"] + " " + styles["dh-accent"]}
                type="submit"
                disabled={!enabled || !branch.trim()}
              >
                Create lane
              </button>
              <button
                type="button"
                className={styles["dh-icon-button"]}
                aria-label="Cancel new lane"
                onClick={() => setCreating(false)}
              >
                <XIcon size={17} />
              </button>
            </div>
            <p>
              The new lane gets independent worktrees and service ports. Services start when you
              choose.
            </p>
          </form>
        ) : null}
        {recoveryError ? (
          <div role="alert" className={styles["dh-status-error"]}>
            <p>Previous operations could not be checked. Check them before starting new work.</p>
            <button className={styles["dh-button"]} onClick={() => setRecoveryErrorScope(null)}>
              Check previous operations
            </button>
          </div>
        ) : null}
        {operation ? (
          <div className={styles["dh-operation"]} role="status">
            <strong>
              {operation.receipt?.method ?? "Workspace operation"}:{" "}
              {operation.refused
                ? "refused"
                : (operation.receipt?.state.replaceAll("_", " ") ?? "awaiting response")}
            </strong>
            <p>
              {operation.message ??
                operation.receipt?.error?.message ??
                (operation.receipt && terminal(operation.receipt)
                  ? "Recorded by Cinderdeck."
                  : "Waiting for Cinderdeck to confirm the result.")}
            </p>
            {operation.receipt?.method === "lane.create" &&
            operation.receipt.state === "succeeded" &&
            createdLaneID ? (
              <Link
                className={styles["dh-button"]}
                to="/workspaces"
                search={{
                  environment: environmentId,
                  workspace: operation.workspaceID,
                  context: createdLaneID,
                  expectedInstallationID: operation.installationID,
                  ...(search.tab ? { tab: search.tab } : {}),
                }}
              >
                Open created lane <ArrowRightIcon size={15} />
              </Link>
            ) : null}
            {!operation.refused &&
            (!operation.receipt || operation.receipt.state === "unknown_outcome") ? (
              <button
                className={styles["dh-button"]}
                onClick={() => {
                  void reconcile();
                }}
              >
                Check operation
              </button>
            ) : operation.refused || (operation.receipt && terminal(operation.receipt)) ? (
              <button className={styles["dh-button"]} onClick={() => setOperation(null)}>
                Dismiss
              </button>
            ) : null}
          </div>
        ) : null}
        {contextResult._tag === "Failure" ? (
          <p role="status" className={styles["dh-status-error"]}>
            Agent relationships could not be refreshed. Saved details may be out of date.
          </p>
        ) : null}
        {agentMode ? (
          <section className={styles["dh-agent-panel"]} aria-label="Agents in selected context">
            <header>
              <div>
                <span className={styles["dh-eyebrow"]}>Agents in</span>
                <h2>{selected ? selectedName : "Choose a context"}</h2>
                <p>
                  Each agent has its own conversation. Agents in this context work in its repository
                  checkouts.
                </p>
              </div>
              {selected?.workspace?.repos[0]?.branch ? (
                <span className={styles["dh-branch"]}>
                  <GitBranchIcon size={15} />
                  {selected.workspace.repos[0].branch}
                </span>
              ) : null}
            </header>
            {selected && view?.hello ? (
              <>
                <details
                  className={styles["dh-add-agent"]}
                  key={`add:${environmentId}:${view.hello.installationID}:${selected.workspaceID}:${selected.generation}`}
                >
                  <summary>
                    <PlusIcon size={16} /> Add an agent to{" "}
                    {selected.workspace?.lane?.name ?? "Primary checkout"}
                  </summary>
                  <SessionLauncher
                    environmentId={environmentId}
                    installationID={view.hello.installationID}
                    resource={selected}
                    enabled={enabled && actionable(selected)}
                  />
                </details>
                <SessionList
                  environmentId={environmentId}
                  installationID={view.hello.installationID}
                  workspaceID={selected.workspaceID}
                  generation={selected.generation}
                  providers={providers}
                />
              </>
            ) : (
              <p>Select an available workspace and checkout to see its agents.</p>
            )}
          </section>
        ) : (
          <section className={styles["dh-lane-list"]} aria-label="Workspace contexts">
            {visible.map((resource) => (
              <LaneRow
                key={resource.workspaceID}
                environmentId={environmentId}
                resource={resource}
                summary={summaryFor(resource)}
                recordingInstallationID={view?.hello?.installationID}
                recording={recordingSummaries?.find(
                  (item) =>
                    item.workspaceID === resource.workspaceID &&
                    item.generation === resource.generation,
                )}
                recordingUnavailable={recordingSummaryError || !nativeCurrent}
                unavailable={agentsUnavailable}
                providers={providers}
                selected={selected?.workspaceID === resource.workspaceID}
                select={() => setSelectedID(resource.workspaceID)}
              />
            ))}
          </section>
        )}
        {view?.workspaceContexts && view.workspaceContexts.total > 50 ? (
          <nav className={styles["dh-page-footer"]} aria-label="Selected workspace context pages">
            <span>
              Workspace contexts {view.workspaceContexts.offset + 1}–
              {Math.min(
                view.workspaceContexts.offset + view.workspaceContexts.resources.length,
                view.workspaceContexts.total,
              )}{" "}
              of {view.workspaceContexts.total}
            </span>
            <button
              className={styles["dh-button"]}
              disabled={!workspaceOffset}
              onClick={() =>
                setWorkspacePage({
                  workspaceID: pageWorkspaceID,
                  offset: Math.max(0, workspaceOffset - 50),
                })
              }
            >
              Previous contexts
            </button>
            <button
              className={styles["dh-button"]}
              disabled={view.workspaceContexts.nextOffset === null}
              onClick={() =>
                setWorkspacePage({
                  workspaceID: pageWorkspaceID,
                  offset: view.workspaceContexts?.nextOffset ?? workspaceOffset,
                })
              }
            >
              Next contexts
            </button>
          </nav>
        ) : null}
        {!agentMode && view?.state === "connected" && !resources.length ? (
          <div className={styles["dh-empty"]}>
            <FolderGit2Icon size={28} />
            <h2>No workspaces yet</h2>
            <p>Add a workspace in Cinderdeck to manage its lanes and services here.</p>
          </div>
        ) : !agentMode &&
          view?.state === "connected" &&
          activeBase &&
          resources.length &&
          !visible.length ? (
          <div className={styles["dh-empty"]}>
            <h2>No loaded contexts match these filters</h2>
            <p>
              Clear the filters or inspect another context page. Your selected context stays
              available in the inspector.
            </p>
            <button
              className={styles["dh-button"]}
              onClick={() => setFilters({ ...defaultWorkspaceFilters })}
            >
              Show all loaded contexts
            </button>
          </div>
        ) : null}
        {!agentMode && view ? (
          <footer className={styles["dh-page-footer"]}>
            <span>
              Contexts {view.total ? offset + 1 : 0}–
              {Math.min(offset + view.resources.length, view.total)} of {view.total}
            </span>
            <button
              className={styles["dh-button"]}
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - pageInput.limit))}
            >
              Previous
            </button>
            <button
              className={styles["dh-button"]}
              disabled={view.nextOffset === null}
              onClick={() => setOffset(view.nextOffset ?? offset)}
            >
              Next
            </button>
          </footer>
        ) : null}
      </main>
      <aside className={styles["dh-inspector"]} aria-label="Selected context">
        <span className={styles["dh-eyebrow"]}>Selected context</span>
        <h2>
          {selected?.workspace?.lane?.name ?? (selected ? "Primary checkout" : "Choose a context")}
        </h2>
        {selected ? (
          <>
            <span className={styles["dh-branch"]}>
              <GitBranchIcon size={16} />
              {selected.workspace?.repos[0]?.branch || "Branch unavailable"}
            </span>
            {summaryFor(selected)?.sessions[0] ? (
              <Link
                className={styles["dh-button"] + " " + styles["dh-accent"]}
                to="/$environmentId/$threadId"
                params={buildThreadRouteParams({
                  environmentId,
                  threadId: summaryFor(selected)!.sessions[0]!.binding.threadId,
                })}
              >
                Open latest conversation <ArrowRightIcon size={15} />
              </Link>
            ) : null}
            <div className={styles["dh-inspector-actions"]}>
              <button
                className={styles["dh-button"] + " " + styles["dh-accent"]}
                disabled={
                  !enabled ||
                  !actionable(selected) ||
                  !selected.workspace?.services.length ||
                  !view?.hello?.capabilities.includes("operations.services")
                }
                onClick={() => {
                  void run(selected, "services.start");
                }}
              >
                Start services
              </button>
              <button
                className={styles["dh-button"]}
                disabled={
                  !enabled ||
                  !actionable(selected) ||
                  !selected.workspace?.services.length ||
                  !view?.hello?.capabilities.includes("operations.services")
                }
                onClick={() => {
                  void run(selected, "services.stop");
                }}
              >
                Stop services
              </button>
            </div>
            {view?.hello && selected.workspace?.lane ? (
              <LaneLifecycleControls
                key={`lifecycle:${environmentId}:${view.hello.installationID}:${selected.workspaceID}:${selected.generation}`}
                environmentId={environmentId}
                installationID={view.hello.installationID}
                resource={selected}
                capabilities={view.hello.capabilities}
                enabled={nativeActionsEnabled && actionable(selected)}
                onPending={setLifecyclePending}
              />
            ) : null}
            {!agentMode && view?.hello ? (
              <SessionList
                environmentId={environmentId}
                installationID={view.hello.installationID}
                workspaceID={selected.workspaceID}
                generation={selected.generation}
                providers={providers}
              />
            ) : null}
            {!agentMode && view?.hello ? (
              <details className={styles["dh-add-agent"]}>
                <summary>Add an agent</summary>
                <SessionLauncher
                  key={`${environmentId}:${view.hello.installationID}:${selected.workspaceID}:${selected.generation}`}
                  environmentId={environmentId}
                  installationID={view.hello.installationID}
                  resource={selected}
                  enabled={enabled && actionable(selected)}
                />
              </details>
            ) : null}
            <h3>Services</h3>
            {selected.available &&
            selected.workspace &&
            !selected.workspace.issues.length &&
            !selected.workspace.services.length ? (
              <p>No services in this context.</p>
            ) : null}
            {selected.workspace?.services.map((service) => (
              <div key={service.name} className={styles["dh-inspector-service"]}>
                <strong>{service.name}</strong>
                <span>{service.phase}</span>
                {service.url ? <code>{service.url}</code> : null}
              </div>
            ))}
            <h3>Repositories</h3>
            {selected.workspace?.repos.map((repo) => (
              <div className={styles["dh-inspector-repo"]} key={repo.id}>
                <strong>{repo.id}</strong>
                <span>{repo.dirty ? `${repo.changedFiles} changed files` : "Clean"}</span>
                <details>
                  <summary>Source location</summary>
                  <code>{repo.path}</code>
                </details>
              </div>
            ))}
          </>
        ) : null}
        <h3>
          <ActivityIcon size={17} />
          Activity
        </h3>
        {!view?.activity.some((event) =>
          contexts.some((resource) => resource.workspaceID === event.workspaceID),
        ) ? (
          <p className={styles["dh-activity-empty"]}>
            New workspace activity appears here while connected.
          </p>
        ) : null}
        <ol className={styles["dh-activity"]}>
          {view?.activity
            .filter((event) =>
              contexts.some((resource) => resource.workspaceID === event.workspaceID),
            )
            .toReversed()
            .slice(0, 12)
            .map((event) => (
              <li key={event.eventID}>
                <i />
                <strong>{event.kind.replace("workspace.", "Context ")}</strong>
                <span>{event.occurredAt ?? event.observedAt ?? "Time unavailable"}</span>
              </li>
            ))}
        </ol>
        <div className={styles["dh-connection"]} data-connected={nativeCurrent}>
          <i />
          <span>{connectionLabel}</span>
        </div>
      </aside>
    </div>
  );
}

function LaneRow({
  environmentId,
  resource,
  summary,
  recording,
  recordingInstallationID,
  recordingUnavailable,
  unavailable,
  providers,
  selected,
  select,
}: {
  environmentId: EnvironmentId;
  resource: Resource;
  summary: ManagedContextView | undefined;
  recording: RecordingContextOverview | undefined;
  recordingInstallationID: string | undefined;
  recordingUnavailable: boolean;
  unavailable: boolean;
  providers: ReadonlyArray<{ instanceId: string; displayName: string }>;
  selected: boolean;
  select: () => void;
}) {
  const sessions = summary?.sessions ?? [];
  const prs = [
    ...new Map(
      sessions
        .flatMap((session) =>
          (session.pullRequests ?? []).filter((pr) => pr.source !== "stack-dismissed"),
        )
        .map((pr) => [`${pr.host}/${pr.repository}/${pr.number}`, pr]),
    ).values(),
  ];
  return (
    <article
      className={`${styles["dh-lane-row"]} ${selected ? styles["dh-lane-selected"] : ""}`}
      aria-label={resource.workspace?.lane?.name ?? "Primary checkout"}
    >
      <div className={styles["dh-lane-identity"]}>
        <button className={styles["dh-lane-select"]} aria-pressed={selected} onClick={select}>
          <h2>{resource.workspace?.lane?.name ?? "Primary checkout"}</h2>
          <ChevronRightIcon size={16} />
        </button>
        <span className={styles["dh-branch"]}>
          <GitBranchIcon size={15} />
          {resource.workspace?.repos[0]?.branch || "Branch unavailable"}
        </span>
        <p className={styles["dh-objective"]}>
          {sessions[0]?.objective ??
            (resource.workspace?.lane
              ? "Independent workspace for changes and verification."
              : "The workspace’s primary source trees.")}
        </p>
        <div className={styles["dh-service-chips"]}>
          {resource.workspace?.services.map((service) => (
            <span key={service.name}>
              <i data-ready={!unavailable && service.ready} />
              {service.name}
              {service.port ? ` :${service.port}` : ""}
            </span>
          ))}
        </div>
        {!resource.available ||
        resource.workspace?.issues.length ||
        resource.workspace?.definitionChanged ? (
          <p role="status" className={styles["dh-attention-text"]}>
            {!resource.available
              ? "Context removed"
              : (resource.workspace?.issues[0] ?? "Workspace definition changed")}
          </p>
        ) : null}
      </div>
      <div className={styles["dh-row-column"]}>
        <span className={styles["dh-column-label"]}>
          Managed agents{summary ? ` · ${summary.total}` : ""}
        </span>
        {!summary ? (
          <p>{unavailable ? "Agents unavailable" : "Loading agents…"}</p>
        ) : !sessions.length ? (
          <p>No managed agents yet</p>
        ) : (
          sessions.map((session) => (
            <Link
              key={session.binding.id}
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams({ environmentId, threadId: session.binding.threadId })}
              className={styles["dh-row-agent"]}
            >
              <strong>{session.title}</strong>
              <span
                data-execution={
                  unavailable || session.source === "unavailable"
                    ? "unknown"
                    : session.binding.execution
                }
              >
                <i />
                {unavailable
                  ? "Last observed"
                  : agentExecutionLabel(
                      session.binding.execution,
                      session.source === "unavailable",
                    )}
              </span>
              <small>
                {agentProviderLabel(session.binding.providerInstanceId, providers)} ·{" "}
                {session.binding.role}
                {session.archived ? " · Archived" : ""}
              </small>
            </Link>
          ))
        )}
        {summary?.externalSessions && !summary.externalSessions.unavailable ? (
          <p>
            {summary.externalSessions.activeCount} reported external
            {unavailable ? " · last observed" : ""}
            {summary.externalSessions.staleCount
              ? ` · ${summary.externalSessions.staleCount} last seen`
              : ""}
          </p>
        ) : (
          <p>External registrations unavailable</p>
        )}
        {summary && summary.total > sessions.length ? (
          <p>
            Showing {sessions.length} newest agents. Open the Agents tab for older conversations.
          </p>
        ) : null}
      </div>
      <div className={styles["dh-row-column"]}>
        <span className={styles["dh-column-label"]}>Pull requests</span>
        {prs.map((pr) => (
          <a
            key={`${pr.host}/${pr.repository}/${pr.number}`}
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className={styles["dh-row-pr"]}
          >
            <strong>
              <PullRequestGlyph.pullRequest size={14} />#{pr.number}{" "}
              <span className={styles["dh-pr-status"]}>
                {pr.snapshot?.isDraft ? "Draft" : (pr.snapshot?.state ?? "Not refreshed")}
              </span>
            </strong>
            <p>{pr.snapshot?.title ?? pr.repository}</p>
            {pr.snapshot ? (
              <small>Cached {new Date(pr.snapshot.syncedAt).toLocaleString()}</small>
            ) : null}
          </a>
        ))}
        {!prs.length ? (
          <p>
            {!summary || unavailable ? "PR links unavailable" : "No PR linked to these agents."}
          </p>
        ) : null}
      </div>
      <div className={styles["dh-row-column"]}>
        <span className={styles["dh-column-label"]}>
          Recordings{recording ? ` · ${recording.count}` : ""}
        </span>
        {recordingUnavailable ? (
          <p>Recording library unavailable</p>
        ) : !recording ? (
          <p>Loading recordings…</p>
        ) : recording.latest ? (
          <Link
            className={styles["dh-row-recording"]}
            to="/recordings"
            search={{
              environment: environmentId,
              workspace: resource.workspaceID,
              recording: recording.latest.id,
              expectedGeneration: resource.generation,
              ...(recordingInstallationID
                ? { expectedInstallationID: recordingInstallationID }
                : {}),
            }}
          >
            {recordingInstallationID ? (
              <RecordingThumbnail
                className={styles["dh-recording-frame"]}
                environmentId={environmentId}
                context={{
                  installationID: recordingInstallationID,
                  workspaceID: resource.workspaceID,
                  generation: resource.generation,
                }}
                recordingID={recording.latest.id}
                playable={recording.latest.playable}
                title={recording.latest.title}
                duration={recording.latest.duration}
              />
            ) : null}
            <strong>{recording.latest.title}</strong>
            <small>
              {recording.active
                ? "Capture in progress"
                : recording.latest.playable
                  ? "Video available"
                  : "Video unavailable"}{" "}
              ·{" "}
              {recording.latest.checkOutcome === "unverified"
                ? "No check recorded"
                : `Recorded check ${recording.latest.checkOutcome}`}
            </small>
          </Link>
        ) : (
          <p>No recordings yet</p>
        )}
        <Link
          className={styles["dh-text-button"]}
          to="/services"
          search={{
            environment: environmentId,
            workspace: resource.workspaceID,
            expectedGeneration: resource.generation,
            ...(recordingInstallationID ? { expectedInstallationID: recordingInstallationID } : {}),
          }}
        >
          Services & runs <ArrowRightIcon size={13} />
        </Link>
        <button className={styles["dh-text-button"]} onClick={select}>
          Inspect {resource.workspace?.lane ? "lane" : "checkout"} <ArrowRightIcon size={13} />
        </button>
      </div>
    </article>
  );
}
