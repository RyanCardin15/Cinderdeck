import { RefreshButton } from "../components/ui/refresh-button";
import { NativeWorkspaceTools } from "./NativeWorkspaceTools";
import native from "./nativeWorkspace.module.css";
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  ActivityIcon,
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  FileCodeIcon,
  PlayIcon,
  RefreshCwIcon,
  ServerIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import type { EnvironmentId } from "@cinderdeck/contracts";
import {
  IntegrationOperationInput,
  type IntegrationOperationMethod,
  type IntegrationOperationReceipt,
  type IntegrationRepository,
} from "@cinderdeck/contracts/deckhand/integration";
import type {
  DefinitionValidation,
  RunContext,
  RunDefinition,
  RunDetail,
  RunLogs,
  RunsOverview,
} from "@cinderdeck/contracts/deckhand/runsRpc";
import * as Option from "effect/Option";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { runtime } from "../lib/runtime";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { ProductNavigation } from "./ProductNavigation";
import { workspaceView, submitOperation, inspectOperation, recentOperations } from "./state";
import { listRuns, getRun, runLogs, runDefinition, validateRunDefinition } from "./runState";
import {
  overviewResources,
  savedWorkspaceMatches,
  type WorkspaceSearch,
} from "./workspaceNavigation";
import { servicesWorkspaceSearch } from "./servicesNavigation";
import styles from "./services.module.css";
const activeStatuses = new Set(["queued", "running", "cancelling"]);
const elapsed = (duration: number) =>
  duration < 60
    ? `${Math.round(duration)}s`
    : `${Math.floor(duration / 60)}m ${Math.floor(duration % 60)}s`;
const decodeOperation = Schema.decodeUnknownSync(IntegrationOperationInput);
export function ServicesRunsPage() {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const search = useSearch({ from: "/_chat/services" });
  const navigate = useNavigate();
  const environmentId = search.environment
    ? environments.find((item) => item.environmentId === search.environment)?.environmentId
    : (primary ?? environments[0]?.environmentId);
  const computerSelector = (
    <label className={styles.computer}>
      Execution computer
      <select
        aria-label="Execution computer"
        value={environmentId ?? search.environment ?? ""}
        onChange={(event) => {
          void navigate({ to: "/services", search: { environment: event.target.value } });
        }}
      >
        {!environmentId && search.environment ? (
          <option value={search.environment}>Unavailable computer</option>
        ) : null}
        {environments.map((item) => (
          <option value={item.environmentId} key={item.environmentId}>
            {item.label}
          </option>
        ))}
      </select>
    </label>
  );
  return environmentId ? (
    <ServicesWorkspace environmentId={environmentId} computerSelector={computerSelector} />
  ) : (
    <div className={`${styles.shell} ${native.workspace}`}>
      <ProductNavigation current="services">{computerSelector}</ProductNavigation>
      <main className={styles.empty}>
        <ServerIcon />
        <h1>Services & runs</h1>
        <p>
          {search.environment
            ? "The selected execution computer is unavailable. Choose another computer explicitly."
            : "Connect an execution computer to manage its workspace services."}
        </p>
        <Link to="/settings/connections">Manage connections</Link>
      </main>
    </div>
  );
}
function ServicesWorkspace({
  environmentId,
  computerSelector,
}: {
  environmentId: EnvironmentId;
  computerSelector: ReactNode;
}) {
  const search = useSearch({ from: "/_chat/services" });
  const navigate = useNavigate();
  const result = useAtomValue(
    workspaceView({
      environmentId,
      input: {
        offset: 0,
        limit: 100,
        ...(search.workspace ? { selectedContextID: search.workspace } : {}),
      },
    }),
  );
  const view = Option.getOrNull(AsyncResult.value(result));
  const resources = overviewResources(view).filter((resource) => resource.available);
  const selected = search.workspace
    ? resources.find((resource) => resource.workspaceID === search.workspace)
    : resources[0];
  const connected = view?.state === "connected";
  const savedMatches = savedWorkspaceMatches(
    search,
    view?.hello?.installationID,
    selected?.generation,
  );
  return (
    <div className={`${styles.shell} ${native.workspace}`}>
      <ProductNavigation
        current="services"
        workspaceSearch={servicesWorkspaceSearch(
          environmentId,
          search,
          selected,
          view?.hello?.installationID,
        )}
        connection={{
          label: connected ? "Cinderdeck connected" : "Cinderdeck unavailable",
          connected,
        }}
      >
        {computerSelector}
      </ProductNavigation>
      <main className={styles.page}>
        <header className={styles.header}>
          <div>
            <span className={styles.eyebrow}>Workspace operations</span>
            <h1>Services & runs</h1>
            <p>Keep the workspace running. Know exactly what finished.</p>
          </div>
          <label>
            Workspace
            <ChevronDownIcon size={14} />
            <select
              aria-label="Services workspace"
              value={selected?.workspaceID ?? ""}
              onChange={(event) => {
                void navigate({
                  to: "/services",
                  search: { environment: environmentId, workspace: event.target.value },
                });
              }}
            >
              {search.workspace && !selected ? (
                <option value="">Selected workspace unavailable</option>
              ) : null}
              {resources.map((resource) => (
                <option key={resource.workspaceID} value={resource.workspaceID}>
                  {resource.workspace?.name ?? resource.workspaceID}
                </option>
              ))}
            </select>
          </label>
        </header>
        {connected && selected && view.hello && !savedMatches ? (
          <section className={styles.empty} role="alert">
            <ServerIcon />
            <h2>This saved run belongs to a different workspace identity</h2>
            <p>
              The installation or workspace generation changed. Reconnect to the saved computer or
              deliberately open the current workspace.
            </p>
            <button
              type="button"
              onClick={() => {
                void navigate({
                  to: "/services",
                  search: { environment: environmentId, workspace: selected.workspaceID },
                });
              }}
            >
              Open current workspace
            </button>
          </section>
        ) : connected && selected && view.hello ? (
          <ServicesRuns
            key={`${environmentId}:${view.hello.installationID}:${selected.workspaceID}:${selected.generation}`}
            environmentId={environmentId}
            context={{
              installationID: view.hello.installationID,
              workspaceID: selected.workspaceID,
              generation: selected.generation,
            }}
            {...(search.run ? { initialRunID: search.run } : {})}
          />
        ) : (
          <section className={styles.empty}>
            <ServerIcon />
            <h2>
              {connected
                ? search.workspace
                  ? "Selected workspace unavailable"
                  : "No available workspaces"
                : "Connect Cinderdeck to manage services"}
            </h2>
            <p>Choose the Cinderdeck installation on this execution computer.</p>
            <Link to="/settings/connections">
              Manage connection <ArrowRightIcon size={14} />
            </Link>
          </section>
        )}
      </main>
    </div>
  );
}
export function ServicesRuns({
  environmentId,
  context,
  initialRunID,
  workspaceSearch,
  onSelectRun,
  panel = "all",
  repositories,
}: {
  environmentId: EnvironmentId;
  context: RunContext;
  initialRunID?: string;
  workspaceSearch?: WorkspaceSearch;
  onSelectRun?: (run: string) => void;
  panel?: "all" | "services" | "tasks" | "workflows" | "runs";
  repositories?: ReadonlyArray<typeof IntegrationRepository.Type> | undefined;
}) {
  const scope = useMemo(
    () => ({
      installationID: context.installationID,
      workspaceID: context.workspaceID,
      generation: context.generation,
    }),
    [context.installationID, context.workspaceID, context.generation],
  );
  const operations = useAtomCommand(recentOperations, { reportFailure: false });
  const list = useAtomCommand(listRuns, { reportFailure: false });
  const get = useAtomCommand(getRun, { reportFailure: false });
  const logs = useAtomCommand(runLogs, { reportFailure: false });
  const definition = useAtomCommand(runDefinition, { reportFailure: false });
  const validate = useAtomCommand(validateRunDefinition, { reportFailure: false });
  const submit = useAtomCommand(submitOperation, { reportFailure: false });
  const inspect = useAtomCommand(inspectOperation, { reportFailure: false });
  const [overview, setOverview] = useState<RunsOverview | null>(null);
  const storageKey = `deckhand:run-operation:${environmentId}:${context.installationID}:${context.workspaceID}:${context.generation}`;
  const [restored] = useState(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return { pending: null, error: null };
      const saved = decodeOperation(JSON.parse(raw));
      if (
        saved.installationID !== context.installationID ||
        saved.workspaceID !== context.workspaceID ||
        saved.generation !== context.generation
      )
        throw new Error("Context changed");
      return { pending: saved, error: null };
    } catch {
      return {
        pending: null,
        error:
          "A saved operation could not be read. Inspect your operation history before starting more work.",
      };
    }
  });
  const [error, setError] = useState<string | null>(restored.error);
  const [loading, setLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(restored.error !== null);
  const [pending, setPending] = useState<IntegrationOperationInput | null>(restored.pending);
  const [receipt, setReceipt] = useState<IntegrationOperationReceipt | null>(null);
  const [selectedID, setSelectedID] = useState(initialRunID ?? "");
  const [detail, setDetail] = useState<(RunDetail & { stepOffset: number }) | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [stepOffsets, setStepOffsets] = useState([0]);
  const detailVersion = useRef(0);
  const [logView, setLogView] = useState<RunLogs>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [tab, setTab] = useState<"tasks" | "workflows">("tasks");
  const [editing, setEditing] = useState(false);
  const [savedDefinition, setDefinition] = useState<RunDefinition | null>(null);
  const [source, setSource] = useState("");
  const [validation, setValidation] = useState<DefinitionValidation | null>(null);
  const alive = useRef(true);
  const fetching = useRef<Promise<boolean> | null>(null);
  const dispatching = useRef(false);
  const logVersion = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const reload = useCallback(() => {
    if (fetching.current) return fetching.current;
    const request = (async () => {
      try {
        const response = await list({ environmentId, input: scope });
        if (!alive.current) return false;
        if (response._tag !== "Success") throw new Error("Workspace unavailable");
        setOverview(response.value);
        setOverviewError(null);
        return true;
      } catch {
        if (alive.current)
          setOverviewError(
            "Services and run history are unavailable. Check the Cinderdeck connection and refresh to try again.",
          );
        return false;
      } finally {
        if (alive.current) setLoading(false);
        fetching.current = null;
      }
    })();
    fetching.current = request;
    return request;
  }, [list, environmentId, scope]);
  const refreshOverview = async () => {
    if (!(await reload()))
      throw new Error("Could not refresh services. Check the Cinderdeck connection and try again.");
  };
  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [reload]);
  const active = overview?.runs.some((run) => activeStatuses.has(run.status)) ?? false;
  const selectedRunID =
    panel === "all" || panel === "runs" ? selectedID || overview?.runs[0]?.id : undefined;
  const stepOffset = stepOffsets[stepOffsets.length - 1] ?? 0;
  useEffect(() => {
    setStepOffsets([0]);
  }, [selectedRunID]);
  useEffect(() => {
    setSelectedID(initialRunID ?? "");
  }, [initialRunID]);
  const selectedSummary = overview?.runs.find((run) => run.id === selectedRunID);
  const selected =
    detail && detail.run.id === selectedRunID && detail.stepOffset === stepOffset
      ? detail.run
      : undefined;
  const refreshDetail = useCallback(async () => {
    if (!selectedRunID) return;
    const version = ++detailVersion.current;
    if (!overview?.detailAvailable) {
      setDetailLoading(false);
      if (selectedSummary) {
        setDetail({
          ...{
            run: selectedSummary,
            totalSteps: selectedSummary.steps.length,
            nextStepOffset: null,
          },
          stepOffset: 0,
        });
        setDetailError(null);
      } else {
        setDetail(null);
        setDetailError(
          "This run is outside the legacy history projection. Update Cinderdeck for exact-ID history access, or open its saved native history.",
        );
      }
      return;
    }
    setDetailLoading(true);
    setDetailError(null);
    try {
      const response = await get({
        environmentId,
        input: { ...scope, runID: selectedRunID, stepOffset, stepLimit: 16 },
      });
      if (!alive.current || version !== detailVersion.current) return;
      if (response._tag === "Success") setDetail({ ...response.value, stepOffset });
      else {
        setDetail(null);
        setDetailError(
          "This saved run is unavailable. Its identity was preserved; refresh or choose another run explicitly.",
        );
      }
    } catch {
      if (alive.current && version === detailVersion.current) {
        setDetail(null);
        setDetailError("Run details could not be loaded. Refresh to try again.");
      }
    } finally {
      if (alive.current && version === detailVersion.current) setDetailLoading(false);
    }
  }, [
    get,
    environmentId,
    scope,
    selectedRunID,
    stepOffset,
    overview?.detailAvailable,
    selectedSummary,
  ]);
  useEffect(() => {
    setDetail(null);
    void refreshDetail();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshDetail();
    }, 4000);
    return () => {
      window.clearInterval(timer);
      detailVersion.current += 1;
    };
  }, [refreshDetail]);
  const selectedStatus = selected?.status ?? selectedSummary?.status;
  const refreshLogs = useCallback(async () => {
    if (!selectedRunID) return;
    const version = ++logVersion.current;
    setLogLoading(true);
    setLogError(null);
    try {
      const response = await logs({ environmentId, input: { ...scope, runID: selectedRunID } });
      if (!alive.current || version !== logVersion.current) return;
      if (response._tag === "Success") setLogView(response.value);
      else setLogError("Run output is unavailable. Check the connection and refresh to try again.");
    } catch {
      if (alive.current && version === logVersion.current)
        setLogError("Run output is unavailable. Check the connection and refresh to try again.");
    } finally {
      if (alive.current && version === logVersion.current) setLogLoading(false);
    }
  }, [logs, environmentId, scope, selectedRunID]);
  useEffect(() => {
    setLogView([]);
    void refreshLogs();
    if (!selectedStatus || !activeStatuses.has(selectedStatus)) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshLogs();
    }, 4000);
    return () => {
      window.clearInterval(timer);
      logVersion.current += 1;
    };
  }, [refreshLogs, selectedStatus]);
  const rememberReceipt = (value: IntegrationOperationReceipt) => {
    setReceipt(value);
    if (value.state === "succeeded" || value.state === "failed") {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        setError("The saved operation could not be cleared.");
        return;
      }
      setPending(null);
    }
    if (value.error) setError(`${value.error.message} (${value.error.code})`);
  };
  const inspectPending = async (input = pending) => {
    if (!input) return;
    setBusy(true);
    const result = await inspect({
      environmentId,
      input: { operationKey: input.operationKey, waitMs: 25000 },
    });
    if (alive.current) {
      if (result._tag === "Success") rememberReceipt(result.value);
      else {
        const history = await operations({ environmentId, input: {} });
        if (!alive.current) return;
        const record =
          history._tag === "Success"
            ? history.value.find((item) => item.input.operationKey === input.operationKey)
            : undefined;
        if (record?.refused) {
          try {
            localStorage.removeItem(storageKey);
            setPending(null);
            setError(
              `Operation refused before effects: ${record.error?.code ?? record.error?.reason ?? "refresh required"}. Refresh and review the workspace before retrying.`,
            );
          } catch {
            setError("The saved operation could not be cleared.");
          }
        } else
          setError(
            "The operation outcome is unavailable. Check this same receipt before starting another operation.",
          );
      }
      setBusy(false);
      void reload();
    }
  };
  const operate = async (method: IntegrationOperationMethod, args: Record<string, unknown>) => {
    if (!overview || busy || pending || dispatching.current) return;
    dispatching.current = true;
    try {
      const input: IntegrationOperationInput = {
        ...context,
        revision: overview.revision,
        operationKey: await runtime.runPromise(
          Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
        ),
        method,
        arguments: { workspace: context.workspaceID, ...args },
      };
      try {
        localStorage.setItem(storageKey, JSON.stringify(input));
      } catch {
        setError("The request could not be saved. No operation was sent.");
        return;
      }
      setPending(input);
      setBusy(true);
      setError(null);
      setReceipt(null);
      const response = await submit({ environmentId, input });
      if (!alive.current) return;
      if (response._tag === "Success") {
        rememberReceipt(response.value);
        if (response.value.state === "pending" || response.value.state === "running")
          await inspectPending(input);
        else {
          setBusy(false);
          void reload();
        }
      } else {
        setError(
          "The response was lost or the request was refused. Inspect the saved receipt before sending more work.",
        );
        setBusy(false);
      }
    } catch {
      if (alive.current) {
        setError(
          "The operation could not be prepared or its response is unavailable. Inspect any saved receipt before retrying.",
        );
        setBusy(false);
      }
    } finally {
      dispatching.current = false;
    }
  };
  const openEditor = async () => {
    setBusy(true);
    const response = await definition({ environmentId, input: scope });
    if (alive.current) {
      setBusy(false);
      if (response._tag === "Success") {
        setDefinition(response.value);
        setSource(response.value.source);
        setValidation(null);
        setEditing(true);
      } else setError("This definition is unavailable or too large to edit here.");
    }
  };
  const validateSource = async () => {
    setBusy(true);
    const response = await validate({ environmentId, input: { ...context, source } });
    if (alive.current) {
      setBusy(false);
      if (response._tag === "Success") setValidation(response.value);
      else setError("The definition could not be validated.");
    }
  };
  const disabled = busy || pending !== null;
  const definitionTab = panel === "tasks" || panel === "workflows" ? panel : tab;
  return (
    <div className={styles.operational} data-panel={panel}>
      {error || overviewError || overview?.storageError ? (
        <div className={styles.alert} role="alert">
          <span>{error ?? overviewError ?? overview?.storageError}</span>
          <RefreshButton label="Retry refreshing services and runs" onRefresh={refreshOverview} />
        </div>
      ) : null}
      {pending ? (
        <div className={styles.receipt}>
          <ClockIcon size={16} />
          <div>
            <strong>Operation {receipt?.state?.replaceAll("_", " ") ?? "awaiting receipt"}</strong>
            <p>
              {pending.method} · {pending.operationKey.slice(0, 8)}. Keep this request until its
              outcome is known.
            </p>
          </div>
          <button
            disabled={busy}
            type="button"
            onClick={() => {
              void inspectPending();
            }}
          >
            Inspect receipt
          </button>
        </div>
      ) : null}
      {panel === "all" || panel === "services" ? (
        <section
          className={`${styles.section} ${styles.servicesSection}`}
          aria-labelledby="service-heading"
        >
          <div className={styles.sectionHeader}>
            <div>
              <h2 id="service-heading">
                Services <span>{overview?.services.length ?? "—"}</span>
              </h2>
              <p>Keep APIs, databases, and development servers running together.</p>
            </div>
            <div className={styles.actions}>
              <RefreshButton
                label="Refresh services"
                successMessage="Service status updated"
                onRefresh={refreshOverview}
              />
              <button
                type="button"
                disabled={disabled || !overview?.services.some((service) => !service.sharedFrom)}
                onClick={() => {
                  void operate("services.start", { wait: true, timeout: 120 });
                }}
              >
                <PlayIcon size={14} />
                Start services
              </button>
              <button
                type="button"
                disabled={
                  disabled || active || !overview?.services.some((service) => !service.sharedFrom)
                }
                onClick={() => {
                  void operate("services.stop", {});
                }}
              >
                <SquareIcon size={13} />
                Stop
              </button>
              <button
                type="button"
                disabled={
                  disabled || active || !overview?.services.some((service) => !service.sharedFrom)
                }
                onClick={() => void operate("services.restart", { wait: true, timeout: 120 })}
              >
                <RefreshCwIcon size={14} /> Restart
              </button>
              <NativeWorkspaceTools
                environmentId={environmentId}
                workspaceID={context.workspaceID}
                enabled={!disabled}
                terminal
              />
            </div>
          </div>
          {loading ? (
            <div className={styles.emptySmall}>Loading workspace services…</div>
          ) : overview?.services.length ? (
            <div className={styles.serviceList}>
              {overview.services.map((service) => (
                <article key={service.id} className={styles.service}>
                  <div className={styles.serviceBody}>
                    <div className={styles.serviceTitle}>
                      <i
                        className={styles.serviceDot}
                        data-phase={service.phase}
                        data-ready={service.ready}
                        aria-hidden="true"
                      />
                      <h3>{service.id}</h3>
                      <div className={styles.actions}>
                        {service.sharedFrom ? (
                          <span className={styles.shared}>Shared service</span>
                        ) : (
                          <>
                            <button
                              type="button"
                              aria-label={`Start ${service.id}`}
                              disabled={disabled || service.ready}
                              onClick={() => {
                                void operate("services.start", {
                                  services: [service.id],
                                  wait: true,
                                  timeout: 120,
                                });
                              }}
                            >
                              <PlayIcon size={14} />
                            </button>
                            <button
                              type="button"
                              aria-label={`Restart ${service.id}`}
                              disabled={disabled || active}
                              onClick={() => {
                                void operate("services.restart", {
                                  services: [service.id],
                                  wait: true,
                                  timeout: 120,
                                });
                              }}
                            >
                              <RefreshCwIcon size={14} />
                            </button>
                            <button
                              type="button"
                              aria-label={`Stop ${service.id}`}
                              disabled={disabled || active}
                              onClick={() => {
                                void operate("services.stop", { services: [service.id] });
                              }}
                            >
                              <SquareIcon size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className={styles.serviceFacts}>
                      <span
                        className={styles.status}
                        data-state={service.ready ? "succeeded" : service.phase}
                      >
                        {service.status}
                      </span>
                      {service.port ? <code>:{service.port}</code> : null}
                    </div>
                    <p>
                      {service.detail ??
                        (service.sharedFrom
                          ? `Shared from ${service.sharedFrom}`
                          : (service.command ?? "No command"))}
                    </p>
                    <div className={styles.meta}>
                      {service.dependencies.length ? (
                        <span>Depends on {service.dependencies.join(", ")}</span>
                      ) : (
                        <span>No dependencies</span>
                      )}
                      {service.directory ? (
                        <span aria-label={service.directory}>{service.directory}</span>
                      ) : null}
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className={styles.emptySmall}>
              This workspace has no long-running services. Add them in the workspace definition.
            </div>
          )}
        </section>
      ) : null}
      {panel === "services" && repositories?.length ? (
        <section
          className={`${styles.section} ${styles.repositories}`}
          aria-labelledby="repositories-heading"
        >
          <div className={styles.sectionHeader}>
            <h2 id="repositories-heading">
              Repositories <span>{repositories.length}</span>
            </h2>
          </div>
          {repositories.map((repo) => (
            <article key={repo.id} className={styles.repository}>
              <div>
                <strong>{repo.id}</strong>
                <p>{repo.path}</p>
              </div>
              <code>{repo.branch || "No branch"}</code>
              <span data-dirty={repo.dirty}>
                {repo.changedFiles ? `${repo.changedFiles} changed files` : "Clean"}
              </span>
            </article>
          ))}
        </section>
      ) : null}
      {panel !== "services" ? (
        <div className={styles.lower}>
          {panel !== "runs" ? (
            <section className={styles.section}>
              <div className={styles.sectionHeader}>
                {panel === "all" ? (
                  <div className={styles.tabs} role="tablist" aria-label="Run definitions">
                    <button
                      role="tab"
                      aria-selected={tab === "tasks"}
                      onClick={() => setTab("tasks")}
                    >
                      Tasks <span>{overview?.tasks.length ?? 0}</span>
                    </button>
                    <button
                      role="tab"
                      aria-selected={tab === "workflows"}
                      onClick={() => setTab("workflows")}
                    >
                      Workflows <span>{overview?.workflows.length ?? 0}</span>
                    </button>
                  </div>
                ) : (
                  <h2>{panel === "workflows" ? "Workflows" : "Tasks"}</h2>
                )}
                <button
                  type="button"
                  className={styles.edit}
                  disabled={disabled}
                  onClick={() => {
                    void openEditor();
                  }}
                >
                  <FileCodeIcon size={14} />
                  Edit definition
                </button>
              </div>
              {definitionTab === "tasks"
                ? overview?.tasks.map((task) => (
                    <article className={styles.definition} key={task.id}>
                      <div>
                        <h3>{task.name}</h3>
                        <code>{task.command}</code>
                        <p>
                          {task.requiresServices.length
                            ? `Requires ${task.requiresServices.join(", ")} · `
                            : ""}
                          {task.timeout}s timeout
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={disabled || active}
                        onClick={() => {
                          void operate("runs.start", { kind: "task", definitionID: task.id });
                        }}
                      >
                        <PlayIcon size={14} />
                        Run
                      </button>
                    </article>
                  ))
                : overview?.workflows.map((workflow) => (
                    <article className={styles.definition} key={workflow.id}>
                      <div>
                        <h3>{workflow.name}</h3>
                        <p>{workflow.steps.join(" → ")}</p>
                        <span>
                          {workflow.cleanupServices
                            ? "Stops services started by this run"
                            : "Keeps services running"}
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={disabled || active}
                        onClick={() => {
                          void operate("runs.start", {
                            kind: "workflow",
                            definitionID: workflow.id,
                          });
                        }}
                      >
                        <PlayIcon size={14} />
                        Run
                      </button>
                    </article>
                  ))}
              {!loading &&
              !(definitionTab === "tasks" ? overview?.tasks.length : overview?.workflows.length) ? (
                <div className={styles.emptySmall}>
                  No {definitionTab} defined yet. Define finite commands and workflow steps in this
                  workspace.
                </div>
              ) : null}
            </section>
          ) : null}
          {panel === "all" || panel === "runs" ? (
            <section className={`${styles.section} ${styles.historySection}`}>
              <div className={styles.sectionHeader}>
                <div>
                  <h2>
                    Runs <span>{overview?.runs.length ?? 0}</span>
                  </h2>
                  <p>Exit codes and results from the execution computer.</p>
                  {overview && overview.retainedRunCount === undefined ? (
                    <p role="status">
                      Legacy Cinderdeck history: the retained total and omitted run count are
                      unknown. Update Cinderdeck for complete saved-run access.
                    </p>
                  ) : null}
                  {overview?.runsTruncated ? (
                    <p role="status">
                      Showing {overview.runs.length}
                      {overview.retainedRunCount === undefined
                        ? ""
                        : ` of ${overview.retainedRunCount}`}{" "}
                      retained runs. Saved run links still load their exact run.
                    </p>
                  ) : null}
                </div>
                <ActivityIcon size={16} />
              </div>
              <div className={styles.history}>
                {overview?.runs.map((run) => (
                  <button
                    type="button"
                    className={`${styles.historyRow} ${selected?.id === run.id ? styles.selected : ""}`}
                    onClick={() => {
                      setLogView([]);
                      setStepOffsets([0]);
                      setSelectedID(run.id);
                      onSelectRun?.(run.id);
                    }}
                    key={run.id}
                  >
                    <i data-state={run.status} />
                    <div>
                      <strong>{run.name}</strong>
                      <span>
                        {run.kind} · {new Date(run.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <div className={styles.historyEnd}>
                      <span>{run.status}</span>
                      <small>{elapsed(run.duration)}</small>
                    </div>
                  </button>
                ))}
              </div>
              {!loading && !overview?.runs.length ? (
                <div className={styles.emptySmall}>
                  <ClockIcon size={20} />
                  Your first run will appear here.
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
      {detailLoading && !selected ? <p role="status">Loading saved run details…</p> : null}
      {detailError ? (
        <div className={styles.alert} role="alert">
          {detailError}{" "}
          <button
            type="button"
            onClick={() => {
              void refreshDetail();
            }}
          >
            Refresh run
          </button>
        </div>
      ) : null}
      {selected ? (
        <section className={`${styles.section} ${styles.runDetailPanel}`}>
          <div className={styles.sectionHeader}>
            <div>
              <h2>
                {selected.name}
                <span className={styles.status} data-state={selected.status}>
                  {selected.status}
                </span>
              </h2>
              <p>
                {/^(?:Deckhand|Cinderdeck)\s*·\s*dh-admin:[^\s]+(?:\s+in\s+.+)?$/.test(
                  selected.actor,
                )
                  ? "Cinderdeck workspace controls"
                  : selected.actor.replace(/^Deckhand(?=\s|$)/, "Cinderdeck")}{" "}
                · {elapsed(selected.duration)}
              </p>
            </div>
            <div className={styles.actions}>
              <Link
                to={workspaceSearch ? "/workspaces" : "/recordings"}
                search={
                  workspaceSearch
                    ? { ...workspaceSearch, tab: "recordings" }
                    : { workspace: context.workspaceID, environment: environmentId }
                }
              >
                Record verification <ArrowRightIcon size={13} />
              </Link>
              {selected.cancelAllowed ? (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    void operate("runs.cancel", { runID: selected.id });
                  }}
                >
                  <SquareIcon size={13} />
                  Cancel run
                </button>
              ) : !activeStatuses.has(selected.status) ? (
                <button
                  type="button"
                  disabled={disabled || active}
                  aria-label="Rerun current workspace definition"
                  onClick={() => {
                    void operate("runs.rerun", { runID: selected.id });
                  }}
                >
                  <RefreshCwIcon size={14} />
                  Rerun
                </button>
              ) : null}
            </div>
          </div>
          <details className={styles.runDetail}>
            <summary>Execution details</summary>
            <p>
              Started by: <code className="break-all">{selected.actor}</code>
            </p>
            <p>
              Run ID: <code className="break-all">{selected.id}</code>
            </p>
          </details>
          {!overview?.detailAvailable ? (
            <p className={styles.runDetail}>
              Legacy run projection: step completeness is unknown. Exact command and exit values
              shown here come from saved native history.
            </p>
          ) : null}
          {selected.detail ? <p className={styles.runDetail}>{selected.detail}</p> : null}
          <div className={styles.steps}>
            {selected.steps.map((step) => (
              <div className={styles.step} key={step.id}>
                <i data-state={step.status}>
                  {step.status === "succeeded" ? (
                    <CheckIcon size={13} />
                  ) : step.status === "failed" ? (
                    <XIcon size={13} />
                  ) : (
                    <ClockIcon size={13} />
                  )}
                </i>
                <div>
                  <strong>{step.title}</strong>
                  <span>
                    {step.command ?? step.reference}
                    {step.detail ? ` · ${step.detail}` : ""}
                  </span>
                </div>
                <span>{step.exitCode !== null ? `Exit ${step.exitCode}` : step.status}</span>
              </div>
            ))}
          </div>
          {detail && (stepOffset > 0 || detail.nextStepOffset !== null) ? (
            <div className={styles.actions} aria-label="Run step pages">
              <span>
                Steps {stepOffset + 1}–{stepOffset + selected.steps.length} of {detail.totalSteps}
              </span>
              <button
                type="button"
                disabled={detailLoading || stepOffsets.length < 2}
                onClick={() => setStepOffsets((offsets) => offsets.slice(0, -1))}
              >
                Previous steps
              </button>
              <button
                type="button"
                disabled={detailLoading || detail.nextStepOffset === null}
                onClick={() => {
                  if (detail.nextStepOffset !== null)
                    setStepOffsets((offsets) => [...offsets, detail.nextStepOffset!]);
                }}
              >
                Next steps
              </button>
            </div>
          ) : null}
          <div className={styles.logHeader}>
            <TerminalIcon size={14} />
            <strong>Run output</strong>
            <span>Latest 300 lines</span>
            <button
              type="button"
              onClick={() => {
                void refreshLogs();
              }}
            >
              Refresh
            </button>
          </div>
          {logError ? <p role="alert">{logError}</p> : null}
          <pre className={styles.logs} aria-label="Run output" aria-busy={logLoading}>
            {logView.length
              ? logView.map((line) => `[${line.source}] ${line.text}`).join("\n")
              : logLoading
                ? "Loading run output…"
                : logError
                  ? ""
                  : "No output captured for this run."}
          </pre>
        </section>
      ) : null}
      {editing && savedDefinition ? (
        <dialog
          className={styles.editor}
          ref={(node) => {
            if (node && !node.open) node.showModal();
          }}
          onClose={() => setEditing(false)}
          aria-labelledby="definition-title"
        >
          <header>
            <div>
              <h2 id="definition-title">Workspace definition</h2>
              <p>Validate changes before applying them. Stop services and runs first.</p>
            </div>
            <button
              type="button"
              aria-label="Close definition editor"
              onClick={() => setEditing(false)}
            >
              <XIcon size={18} />
            </button>
          </header>
          {!savedDefinition.editable ? (
            <p className={styles.alert}>
              Lane definitions are generated. Edit the original workspace in Cinderdeck.
            </p>
          ) : null}
          <textarea
            aria-label="Workspace TOML definition"
            spellCheck={false}
            readOnly={!savedDefinition.editable}
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              setValidation(null);
            }}
          />
          {validation ? (
            <div className={validation.valid ? styles.valid : styles.alert}>
              {validation.valid ? "Definition is valid." : "Definition needs attention."}
              {validation.issues.map((issue) => (
                <p key={issue}>{issue}</p>
              ))}
            </div>
          ) : null}
          <footer>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !savedDefinition.editable}
              onClick={() => {
                void validateSource();
              }}
            >
              Validate
            </button>
            <button
              type="button"
              disabled={disabled || !savedDefinition.editable || !validation?.valid}
              onClick={() => {
                setEditing(false);
                void operate("definition.apply", {
                  source,
                  sourceHash: savedDefinition.sourceHash,
                });
              }}
            >
              Apply definition
            </button>
          </footer>
        </dialog>
      ) : null}
    </div>
  );
}
