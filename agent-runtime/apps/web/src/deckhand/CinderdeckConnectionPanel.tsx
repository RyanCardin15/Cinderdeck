import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import type { OperationRecord } from "@t3tools/contracts/deckhand/rpc";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { ArrowRightIcon, CheckIcon, FlameIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import {
  canChooseConnectedWorkspace,
  connectedWorkspaceDestination,
  connectedWorkspaceSearch,
  CINDERDECK_CAPABILITIES,
  presentCinderdeckConnection,
  unresolvedIntegrationOperations,
  type ConnectedWorkspaceSelection,
} from "./connectionPresentation";
import { inspectOperation, recentOperations, refreshWorkspaces, workspaceView } from "./state";
import styles from "./connection.module.css";

export function CinderdeckConnectionPanel({
  initialEnvironmentId,
  onChoose,
  nativeHost = false,
}: {
  initialEnvironmentId?: EnvironmentId | undefined;
  onChoose?: ((selection: ConnectedWorkspaceSelection) => Promise<boolean> | void) | undefined;
  nativeHost?: boolean;
}) {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const [selectedID, setSelectedID] = useState<EnvironmentId | null>(
    initialEnvironmentId ?? primary,
  );
  const selected = environments.find((environment) => environment.environmentId === selectedID);
  return (
    <section
      className={styles.panel}
      aria-label={nativeHost ? "Cinderdeck workspaces" : "Cinderdeck connection"}
    >
      <header className={styles.header}>
        <span className={styles.identity}>
          <FlameIcon size={20} aria-hidden /> Cinderdeck
        </span>
        <p>
          {nativeHost
            ? "Your workspaces, lanes, services and recordings are managed here. Choose a workspace to continue; choosing does not start services."
            : "Use the native workspaces on your chosen execution computer. Choosing a workspace opens its context without starting services."}
        </p>
      </header>
      <label className={styles.computer}>
        <span>Execution computer</span>
        <select
          value={selectedID ?? ""}
          onChange={(event) => {
            const environment = environments.find(
              (item) => item.environmentId === event.target.value,
            );
            setSelectedID(environment?.environmentId ?? null);
          }}
        >
          <option value="">Choose a computer</option>
          {selectedID && !selected ? (
            <option value={selectedID}>Unavailable computer</option>
          ) : null}
          {environments.map((environment) => (
            <option key={environment.environmentId} value={environment.environmentId}>
              {environment.label}
            </option>
          ))}
        </select>
      </label>
      {selected && selected.connection.phase === "connected" ? (
        <ConnectionDetails
          key={selected.environmentId}
          environmentId={selected.environmentId}
          onChoose={onChoose}
          nativeHost={nativeHost}
        />
      ) : (
        <div className={styles.notice} role="status">
          <strong>
            {selectedID ? "Execution computer unavailable" : "Choose an execution computer"}
          </strong>
          <p>
            {selectedID
              ? "Reconnect this computer or deliberately select another. Workspace actions will stay scoped to your selection."
              : "Connect a computer to check its Cinderdeck installation."}
          </p>
          {!onChoose ? (
            <Link to="/settings/connections">
              Manage computer connections <ArrowRightIcon size={14} />
            </Link>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ConnectionDetails({
  environmentId,
  onChoose,
  nativeHost,
}: {
  environmentId: EnvironmentId;
  onChoose?: ((selection: ConnectedWorkspaceSelection) => Promise<boolean> | void) | undefined;
  nativeHost: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const result = useAtomValue(workspaceView({ environmentId, input: { offset, limit: 20 } }));
  const view = Option.getOrNull(AsyncResult.value(result));
  const presentation = presentCinderdeckConnection(view, nativeHost);
  const [selection, setSelection] = useState<{
    installationID: string;
    workspaceID: string;
    generation: number;
  } | null>(null);
  const selected =
    view?.hello?.installationID === selection?.installationID
      ? view?.resources.find(
          (resource) =>
            resource.workspaceID === selection?.workspaceID &&
            resource.generation === selection?.generation,
        )
      : undefined;
  const destination =
    selected && view?.hello
      ? connectedWorkspaceDestination(environmentId, view.hello.installationID, selected)
      : null;
  const canChoose = canChooseConnectedWorkspace(view, selected) && destination !== null;
  const refresh = useAtomCommand(refreshWorkspaces, { reportFailure: false });
  const recent = useAtomCommand(recentOperations, { reportFailure: false });
  const inspect = useAtomCommand(inspectOperation, { reportFailure: false });
  const [busy, setBusy] = useState<"refresh" | "choose" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [operations, setOperations] = useState<ReadonlyArray<OperationRecord>>([]);
  const [operationError, setOperationError] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const installationID = view?.state === "connected" ? view.hello?.installationID : undefined;
  useEffect(() => {
    if (!installationID) return;
    let disposed = false;
    void recent({ environmentId, input: {} }).then((response) => {
      if (disposed) return;
      setOperationError(response._tag !== "Success");
      if (response._tag === "Success") setOperations(response.value);
    });
    return () => {
      disposed = true;
    };
  }, [environmentId, installationID, recent]);
  const pending = unresolvedIntegrationOperations(operations);
  const checkConnection = async () => {
    setBusy("refresh");
    setMessage(null);
    try {
      const response = await refresh({ environmentId, input: {} });
      if (response._tag !== "Success") {
        setMessage(
          "The connection check could not complete. Try again after checking this computer.",
        );
      } else {
        const saved = await recent({ environmentId, input: {} });
        setOperationError(saved._tag !== "Success");
        if (saved._tag === "Success") setOperations(saved.value);
      }
    } finally {
      setBusy(null);
    }
  };
  const choose = async () => {
    if (!canChoose || !destination || !onChoose) return;
    setBusy("choose");
    setMessage(null);
    try {
      const completed = await onChoose(destination);
      if (completed === false)
        setMessage("Setup could not be saved. Your workspace selection is retained; try again.");
    } finally {
      setBusy(null);
    }
  };
  const checkOperation = async (record: OperationRecord) => {
    if (!installationID || record.input.installationID !== installationID) return;
    setChecking(record.input.operationKey);
    setMessage(null);
    try {
      const response = await inspect({
        environmentId,
        input: { operationKey: record.input.operationKey },
      });
      if (response._tag === "Success") {
        setOperations((current) =>
          current.map((item) =>
            item.input.operationKey === record.input.operationKey
              ? { ...item, receipt: response.value }
              : item,
          ),
        );
        setMessage(`Operation status: ${response.value.state.replaceAll("_", " ")}.`);
      } else
        setMessage(
          "The operation could not be reconciled. Its original identity is retained; check again after reconnecting.",
        );
    } finally {
      setChecking(null);
    }
  };
  return (
    <>
      <div className={styles.status} role="status">
        <div>
          <strong>{presentation.title}</strong>
          <p>{presentation.detail}</p>
        </div>
        <button
          type="button"
          className={styles.secondary}
          disabled={busy !== null}
          onClick={() => void checkConnection()}
        >
          <RefreshCwIcon size={14} aria-hidden />
          {busy === "refresh"
            ? "Checking…"
            : nativeHost
              ? "Refresh workspaces"
              : "Check connection"}
        </button>
      </div>
      {AsyncResult.isFailure(result) ? (
        <p className={styles.notice} role="alert">
          This computer could not load the integration status. Check the connection again.
        </p>
      ) : null}
      {view?.hello ? (
        <details className={styles.connectionDetails}>
          <summary>Connection details</summary>
          <dl className={styles.facts}>
            <div>
              <dt>Installation</dt>
              <dd>{view.hello.installationID}</dd>
            </div>
            <div>
              <dt>Execution host</dt>
              <dd>{view.hello.executionHostID}</dd>
            </div>
            <div>
              <dt>Protocol / channel</dt>
              <dd>
                {view.hello.protocolVersion} / {view.hello.channel}
              </dd>
            </div>
            <div>
              <dt>Last observed</dt>
              <dd>{view.observedAt ?? "Not observed"}</dd>
            </div>
          </dl>
          <ul className={styles.capabilities} aria-label="Reported Cinderdeck capabilities">
            {CINDERDECK_CAPABILITIES.map((capability) => (
              <li key={capability.key}>
                <CheckIcon
                  size={12}
                  aria-hidden
                  className={
                    view.hello?.capabilities.includes(capability.key)
                      ? styles.supported
                      : styles.unsupported
                  }
                />
                <span>{capability.label}</span>
                <span>
                  {view.hello?.capabilities.includes(capability.key) ? "Supported" : "Unavailable"}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <fieldset className={styles.workspaces} disabled={busy !== null}>
        <legend>Choose a Cinderdeck workspace</legend>
        {view?.resources.map((resource) => {
          const available = canChooseConnectedWorkspace(view, resource);
          const checked = selected?.workspaceID === resource.workspaceID;
          return (
            <label
              key={`${resource.workspaceID}:${resource.generation}`}
              className={styles.workspace}
            >
              <input
                type="radio"
                name={`cinderdeck-workspace-${environmentId}`}
                checked={checked}
                disabled={!available}
                onChange={() => {
                  if (view.hello)
                    setSelection({
                      installationID: view.hello.installationID,
                      workspaceID: resource.workspaceID,
                      generation: resource.generation,
                    });
                }}
              />
              <span>
                <strong>{resource.workspace?.name ?? "Unavailable workspace"}</strong>
                <small>
                  {resource.workspace?.lane
                    ? `Lane ${resource.workspace.lane.name}`
                    : "Primary checkout"}{" "}
                  · Cinderdeck owns this context
                </small>
              </span>
              <span className={styles.workspaceStatus}>
                {available
                  ? resource.workspace?.definitionChanged || resource.workspace?.issues.length
                    ? "Needs attention"
                    : "Available"
                  : "Unavailable"}
              </span>
            </label>
          );
        })}
        {view?.state === "connected" && view.resources.length === 0 ? (
          <p>
            {nativeHost
              ? "No workspaces are configured on this computer yet. You can add one from the workspace overview after setup."
              : "No native workspaces are available on this computer. Add a workspace there, then check the connection."}
          </p>
        ) : null}
        {selection && !selected ? (
          <p role="status">
            Your selected workspace changed or is unavailable. Choose a workspace again.
          </p>
        ) : null}
      </fieldset>
      {view && (view.total > 20 || offset > 0) ? (
        <nav className={styles.pagination} aria-label="Cinderdeck workspace pages">
          <button
            type="button"
            disabled={offset === 0 || busy !== null}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            Previous
          </button>
          <span>
            {view.resources.length
              ? `${offset + 1}–${Math.min(offset + 20, view.total)} of ${view.total}`
              : "No workspaces on this page"}
          </span>
          <button
            type="button"
            disabled={view.nextOffset === null || busy !== null}
            onClick={() => {
              if (view.nextOffset !== null) setOffset(view.nextOffset);
            }}
          >
            Next
          </button>
        </nav>
      ) : null}
      {message ? (
        <p className={styles.notice} role="status">
          {message}
        </p>
      ) : null}
      {onChoose ? (
        <button
          type="button"
          className={styles.primary}
          disabled={!canChoose || busy !== null}
          onClick={() => void choose()}
        >
          {busy === "choose" ? "Opening workspace…" : "Open selected workspace"}{" "}
          <ArrowRightIcon size={14} aria-hidden />
        </button>
      ) : selected && canChoose && destination ? (
        <Link
          className={styles.primary}
          to="/workspaces"
          search={connectedWorkspaceSearch(destination)}
        >
          Open selected workspace <ArrowRightIcon size={14} aria-hidden />
        </Link>
      ) : (
        <p className={styles.hint}>Select a workspace to open its overview.</p>
      )}
      {pending.length || operationError ? (
        <section className={styles.recovery} aria-label="Pending Cinderdeck operations">
          <h3>Operations needing attention</h3>
          <p>
            Check an operation using its original identity. Opening a workspace or checking status
            never resubmits the operation.
          </p>
          {operationError ? <p role="alert">Saved operations could not be loaded.</p> : null}
          {pending.slice(0, 20).map((record) => {
            const resource = view?.resources.find(
              (item) => item.workspaceID === record.input.workspaceID,
            );
            const original = resource
              ? connectedWorkspaceDestination(
                  environmentId,
                  record.input.installationID,
                  resource,
                  record.input.generation,
                )
              : null;
            return (
              <article key={record.input.operationKey}>
                <div>
                  <strong>{record.input.method.replaceAll(".", " ")}</strong>
                  <span>{record.receipt?.state.replaceAll("_", " ") ?? "Awaiting receipt"}</span>
                  <code>{record.input.operationKey}</code>
                </div>
                <button
                  type="button"
                  disabled={
                    !installationID ||
                    record.input.installationID !== installationID ||
                    checking !== null
                  }
                  onClick={() => void checkOperation(record)}
                >
                  {checking === record.input.operationKey ? "Checking…" : "Check status"}
                </button>
                {original ? (
                  <Link to="/workspaces" search={connectedWorkspaceSearch(original)}>
                    Review workspace <ArrowRightIcon size={12} aria-hidden />
                  </Link>
                ) : (
                  <span>Workspace identity unavailable</span>
                )}
              </article>
            );
          })}
        </section>
      ) : null}
    </>
  );
}
