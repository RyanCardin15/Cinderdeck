import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  GitBranchIcon,
  LayersIcon,
  PlusIcon,
  ArrowRightIcon,
  RefreshCwIcon,
  SettingsIcon,
  MessagesSquareIcon,
  FolderGit2Icon,
  ActivityIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import * as Option from "effect/Option";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { runtime } from "../lib/runtime";
import { readPullRequestListPreferences } from "../components/pullRequest/pullRequestListPreferences";
import { AsyncResult } from "effect/unstable/reactivity";
import type { EnvironmentId } from "@t3tools/contracts";
import type { IntegrationView } from "@t3tools/contracts/deckhand/rpc";
import type { IntegrationOperationReceipt } from "@t3tools/contracts/deckhand/integration";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { SessionList } from "./SessionList";
import { SessionLauncher } from "./SessionLauncher";
import { DeckhandMark } from "./DeckhandMark";
import {
  workspaceView,
  refreshWorkspaces,
  submitOperation,
  inspectOperation,
  recentOperations,
} from "./state";
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
  const [selected, select] = useState<EnvironmentId | null>(null);
  const environmentId = selected ?? primary ?? environments[0]?.environmentId;
  return (
    <div className={styles["dh-shell"]}>
      <aside className={styles["dh-nav"]} aria-label="Deckhand navigation">
        <Link className={styles["dh-brand"]} to="/workspaces">
          <DeckhandMark aria-hidden="true" />
          <strong>Deckhand</strong>
        </Link>
        <nav className={styles["dh-main-links"]}>
          <Link className={styles["dh-nav-current"]} to="/workspaces">
            <LayersIcon size={18} />
            Workspaces
          </Link>
          <Link to="/">
            <MessagesSquareIcon size={18} />
            Agent conversations
          </Link>
        </nav>
        <label className={styles["dh-field-label"]} htmlFor="dh-environment">
          Execution computer
        </label>
        <select
          id="dh-environment"
          value={environmentId ?? ""}
          onChange={(event) =>
            select(
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
        <p className={styles["dh-nav-note"]}>
          Workspaces keep agents, source trees, and running services in context.
        </p>
        <div className={styles["dh-nav-bottom"]}>
          <Link to="/settings">
            <SettingsIcon size={17} />
            Settings
          </Link>
        </div>
      </aside>
      {environmentId ? (
        <ConnectedWorkspace key={environmentId} environmentId={environmentId} />
      ) : (
        <main className={styles["dh-empty"]}>
          <h1>Choose an execution computer</h1>
          <p>Connect a computer to browse its workspaces.</p>
          <Link to="/settings/connections">
            Manage connections <ArrowRightIcon size={16} />
          </Link>
        </main>
      )}
    </div>
  );
}
function ConnectedWorkspace({ environmentId }: { environmentId: EnvironmentId }) {
  const [offset, setOffset] = useState(0);
  const result = useAtomValue(workspaceView({ environmentId, input: { offset, limit: 100 } }));
  const view = Option.getOrNull(AsyncResult.value(result));
  const [workspaceID, setWorkspaceID] = useState<string | null>(null);
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [branch, setBranch] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<{
    key: string;
    workspaceID: string;
    receipt: IntegrationOperationReceipt | null;
    refused: boolean;
    message: string | null;
  } | null>(null);
  const refresh = useAtomCommand(refreshWorkspaces, { reportFailure: false });
  const submit = useAtomCommand(submitOperation, { reportFailure: false });
  const inspect = useAtomCommand(inspectOperation, { reportFailure: false });
  const recent = useAtomCommand(recentOperations, { reportFailure: false });
  const [recovered, setRecovered] = useState(false);
  const [recoveryError, setRecoveryError] = useState(false);
  useEffect(() => {
    if (recovered || operation || recoveryError || view?.state !== "connected") return;
    let disposed = false;
    void recent({ environmentId, input: {} }).then((response) => {
      if (disposed) return;
      if (response._tag !== "Success") {
        setRecoveryError(true);
        return;
      }
      setRecoveryError(false);
      const unresolved = response.value.find(
        (record) =>
          !record.refused &&
          (!record.receipt ||
            ["pending", "running", "unknown_outcome"].includes(record.receipt.state)),
      );
      if (unresolved)
        setOperation({
          key: unresolved.input.operationKey,
          workspaceID: unresolved.input.workspaceID,
          receipt: unresolved.receipt,
          refused: false,
          message:
            "Recovered a previously submitted operation. Check its result before taking another action.",
        });
      setRecovered(true);
    });
    return () => {
      disposed = true;
    };
  }, [environmentId, recent, recovered, operation, view?.state, recoveryError]);
  const resources = view?.resources ?? [];
  const bases = resources.filter((resource) => !resource.workspace?.lane && resource.available);
  const activeBase = bases.find((resource) => resource.workspaceID === workspaceID) ?? bases[0];
  const contexts = activeBase
    ? resources.filter(
        (resource) =>
          resource.workspaceID === activeBase.workspaceID ||
          resource.workspace?.lane?.sourceStackID === activeBase.workspaceID,
      )
    : resources;
  const lanes = contexts.filter((resource) => resource.workspace?.lane);
  const visible = contexts.filter(
    (resource) =>
      filter !== "attention" ||
      !actionable(resource) ||
      resource.workspace?.services.some((service) => ["failed", "error"].includes(service.phase)),
  );
  const selected =
    contexts.find((resource) => resource.workspaceID === selectedID) ?? lanes[0] ?? activeBase;
  const enabled =
    view?.state === "connected" &&
    !busy &&
    recovered &&
    !(
      operation?.receipt &&
      !operation.refused &&
      !["succeeded", "failed"].includes(operation.receipt.state)
    ) &&
    !(operation && !operation.refused && operation.receipt === null);
  const reconcile = useCallback(async () => {
    if (!operation) return;
    const response = await inspect({ environmentId, input: { operationKey: operation.key } });
    if (response._tag === "Success") {
      const createdID =
        response.value.result?.workspace?.id ?? response.value.result?.createdWorkspaceID;
      if (
        response.value.method === "lane.create" &&
        response.value.state === "succeeded" &&
        createdID
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
  }, [operation, inspect, environmentId]);
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
        receipt: null,
        refused: record?.refused ?? false,
        message: record?.refused
          ? `Cinderdeck refused this operation (${record.error?.code ?? record.error?.reason}). Refresh this context before trying again.`
          : "The response was lost or refused. Check this operation before trying another action.",
      });
    }
  };
  return (
    <>
      <main className={styles["dh-main"]} aria-labelledby="dh-title">
        <header className={styles["dh-header"]}>
          <div>
            <div className={styles["dh-eyebrow"]}>
              Workspaces <span>/</span> {activeBase?.workspace?.name ?? "This computer"}
            </div>
            <h1 id="dh-title">{activeBase?.workspace?.name ?? "Workspaces"}</h1>
            <p>
              {lanes.length} lanes on this page <span>·</span>{" "}
              {contexts.filter((resource) => resource.available).length} working contexts
            </p>
          </div>
          <button
            className={styles["dh-button"] + " " + styles["dh-accent"]}
            disabled={
              !enabled ||
              !activeBase ||
              !actionable(activeBase) ||
              !view?.hello?.capabilities.includes("operations.lane.create")
            }
            onClick={() => setCreating(true)}
          >
            <PlusIcon size={17} />
            New lane
          </button>
        </header>
        <div className={styles["dh-tabs"]}>
          <span className={styles["dh-tab-current"]}>Overview</span>
          <Link to="/">Agent conversations</Link>
          <Link to="/pull-requests" search={readPullRequestListPreferences()}>
            Pull requests
          </Link>
        </div>
        <div className={styles["dh-toolbar"]}>
          <label>
            Workspace{" "}
            <select
              value={activeBase?.workspaceID ?? ""}
              onChange={(event) => {
                setWorkspaceID(event.target.value);
                setSelectedID(null);
              }}
            >
              {bases.map((resource) => (
                <option key={resource.workspaceID} value={resource.workspaceID}>
                  {resource.workspace?.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className={`${styles["dh-filter"]} ${filter === "attention" ? styles["dh-filter-active"] : ""}`}
            aria-pressed={filter === "attention"}
            onClick={() => setFilter(filter === "all" ? "attention" : "all")}
          >
            Needs attention
          </button>
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
        {result._tag === "Failure" ? (
          <div role="alert" className={styles["dh-status-error"]}>
            This computer could not provide workspace data. Check its connection and try refreshing.
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
            <button className={styles["dh-button"]} onClick={() => setRecoveryError(false)}>
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
        <section className={styles["dh-lane-list"]} aria-label="Workspace contexts">
          {visible.map((resource) => (
            <button
              key={resource.workspaceID}
              className={`${styles["dh-lane-row"]} ${selected?.workspaceID === resource.workspaceID ? styles["dh-lane-selected"] : ""}`}
              aria-pressed={selected?.workspaceID === resource.workspaceID}
              onClick={() => setSelectedID(resource.workspaceID)}
            >
              <div className={styles["dh-lane-identity"]}>
                <h2>{resource.workspace?.lane?.name ?? "Primary checkout"}</h2>
                <span className={styles["dh-branch"]}>
                  <GitBranchIcon size={16} />
                  {resource.workspace?.repos[0]?.branch || "Branch unavailable"}
                </span>
                <p>
                  {resource.workspace?.lane
                    ? `${resource.workspace.repos.length} repositories · ${resource.workspace.lane.adopted ? "Adopted worktree" : "Managed lane"}`
                    : "The workspace’s original source trees."}
                </p>
                <div className={styles["dh-service-chips"]}>
                  {resource.workspace?.services.map((service) => (
                    <span key={service.name}>
                      <i data-ready={service.ready} />
                      {service.name}
                      {service.port ? ` :${service.port}` : ""}
                    </span>
                  ))}
                </div>
              </div>
              <div className={styles["dh-row-column"]}>
                <span className={styles["dh-column-label"]}>Services</span>
                <strong>{resource.workspace?.state ?? "Unavailable"}</strong>
                <p>
                  {resource.workspace?.services.filter((service) => service.ready).length ?? 0}{" "}
                  ready / {resource.workspace?.services.length ?? 0}
                </p>
              </div>
              <div className={styles["dh-row-column"]}>
                <span className={styles["dh-column-label"]}>Source trees</span>
                <strong>
                  {resource.workspace?.repos.reduce(
                    (count, repo) => count + repo.changedFiles,
                    0,
                  ) ?? 0}{" "}
                  changed files
                </strong>
                <p>
                  {resource.workspace?.repos.map((repo) => repo.id).join(" · ") ||
                    "No repository data"}
                </p>
              </div>
              <div className={styles["dh-row-column"]}>
                <span className={styles["dh-column-label"]}>Context</span>
                <strong>
                  {resource.available
                    ? resource.workspace?.definitionChanged
                      ? "Definition changed"
                      : resource.workspace?.issues.length
                        ? "Needs attention"
                        : "Available"
                    : "Removed"}
                </strong>
                <p>
                  {resource.workspace?.issues[0] ??
                    (resource.workspace?.lane
                      ? "Independent service environment"
                      : "Primary workspace")}
                </p>
              </div>
            </button>
          ))}
        </section>
        {view?.state === "connected" && !resources.length ? (
          <div className={styles["dh-empty"]}>
            <FolderGit2Icon size={28} />
            <h2>No workspaces yet</h2>
            <p>Add a workspace in Cinderdeck to manage its lanes and services here.</p>
          </div>
        ) : view?.state === "connected" && resources.length && !visible.length ? (
          <div className={styles["dh-empty"]}>
            <h2>No contexts need attention</h2>
            <p>Choose all contexts to see this workspace.</p>
            <button className={styles["dh-button"]} onClick={() => setFilter("all")}>
              Show all contexts
            </button>
          </div>
        ) : null}
        {view ? (
          <footer className={styles["dh-page-footer"]}>
            <span>
              Contexts {view.total ? offset + 1 : 0}–
              {Math.min(offset + resources.length, view.total)} of {view.total}
            </span>
            <button
              className={styles["dh-button"]}
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 100))}
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
            <div className={styles["dh-inspector-actions"]}>
              <button
                className={styles["dh-button"] + " " + styles["dh-accent"]}
                disabled={
                  !enabled ||
                  !actionable(selected) ||
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
                  !view?.hello?.capabilities.includes("operations.services")
                }
                onClick={() => {
                  void run(selected, "services.stop");
                }}
              >
                Stop
              </button>
            </div>
            {view?.hello ? (
              <SessionList
                environmentId={environmentId}
                installationID={view.hello.installationID}
                workspaceID={selected.workspaceID}
                generation={selected.generation}
              />
            ) : null}
            {view?.hello ? (
              <SessionLauncher
                key={`${environmentId}:${view.hello.installationID}:${selected.workspaceID}:${selected.generation}`}
                environmentId={environmentId}
                installationID={view.hello.installationID}
                resource={selected}
                enabled={enabled && actionable(selected)}
              />
            ) : null}
            <h3>Services</h3>
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
                <code>{repo.path}</code>
              </div>
            ))}
          </>
        ) : null}
        <h3>
          <ActivityIcon size={17} />
          Activity
        </h3>
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
        <div className={styles["dh-connection"]} data-connected={view?.state === "connected"}>
          <i />
          <span>{view ? label(view.state) : "Waiting for this computer"}</span>
        </div>
      </aside>
    </>
  );
}
