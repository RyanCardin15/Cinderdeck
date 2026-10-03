import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Contracts from "@t3tools/contracts/deckhand/rpc";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { runtime } from "../lib/runtime";
import { buildThreadRouteParams } from "../threadRoutes";
import { useAtomCommand } from "../state/use-atom-command";
import { launchSession, inspectSessionLaunch, sessionLaunchOptions } from "./state";
import styles from "./workspace.module.css";

type Resource = Contracts.IntegrationView["resources"][number];
type Choice = typeof Contracts.ManagedLaunchOption.Type;
const isDeckhandRpcError = Schema.is(Contracts.DeckhandRpcError);
const decodeLaunchInput = Schema.decodeUnknownSync(Contracts.ManagedLaunchInput);
const decodeDraft = Schema.decodeUnknownSync(Schema.fromJsonString(Contracts.ManagedLaunchInput));
const encodeDraft = Schema.encodeSync(Schema.fromJsonString(Contracts.ManagedLaunchInput));
const failureReason = (cause: Cause.Cause<unknown>): string | undefined => {
  const error = Option.getOrNull(Cause.findErrorOption(cause));
  return isDeckhandRpcError(error) ? error.reason : undefined;
};
const reasonLabel = (reason: string | undefined) =>
  ({
    stale_context: "This context changed. Refresh the workspace before launching again.",
    unavailable_provider:
      "This provider is unavailable or does not support the selected permissions.",
    launch_failed:
      "The launch was saved, but intake failed. Check the result or retry this launch.",
    wrong_actor:
      "This saved launch belongs to a different sign-in. Its owner can check the result.",
    key_conflict: "This launch key already belongs to a different request.",
    missing: "No saved launch was found. You can retry this same request.",
  })[reason ?? ""] ??
  "The launch result could not be confirmed. Check its result before starting another launch.";
export function SessionLauncher({
  environmentId,
  installationID,
  resource,
  enabled,
}: {
  environmentId: EnvironmentId;
  installationID: string;
  resource: Resource;
  enabled: boolean;
}) {
  const navigate = useNavigate();
  const storageKey = `deckhand:launch:${environmentId}:${installationID}:${resource.workspaceID}:${resource.generation}`;
  const [saved, setSaved] = useState<Contracts.ManagedLaunchInput | null>(() => {
    try {
      const value = localStorage.getItem(storageKey);
      return value ? decodeDraft(value) : null;
    } catch {
      return null;
    }
  });
  const [choices, setChoices] = useState<ReadonlyArray<Choice>>([]);
  const [optionsError, setOptionsError] = useState(false);
  const [repositoryID, setRepositoryID] = useState(
    saved?.repositoryID ?? resource.workspace?.repos[0]?.id ?? "",
  );
  const [instanceId, setInstanceId] = useState<string>(saved?.modelSelection.instanceId ?? "");
  const [model, setModel] = useState(saved?.modelSelection.model ?? "");
  const [title, setTitle] = useState(saved?.title ?? "");
  const [objective, setObjective] = useState(saved?.objective ?? "");
  const [runtimeMode, setRuntimeMode] = useState<Contracts.ManagedLaunchInput["runtimeMode"]>(
    saved?.runtimeMode ?? "approval-required",
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(
    saved ? "A launch request is saved. Check its result or retry the same request." : null,
  );
  const [confirmedRefusal, setConfirmedRefusal] = useState(false);
  const [record, setRecord] = useState<Contracts.ManagedLaunchRecord | null>(null);
  const launch = useAtomCommand(launchSession, { reportFailure: false });
  const inspect = useAtomCommand(inspectSessionLaunch, { reportFailure: false });
  const options = useAtomCommand(sessionLaunchOptions, { reportFailure: false });
  useEffect(() => {
    let disposed = false;
    void options({ environmentId, input: {} }).then((result) => {
      if (disposed) return;
      if (result._tag !== "Success") {
        setOptionsError(true);
        return;
      }
      setChoices(result.value);
      setOptionsError(false);
    });
    return () => {
      disposed = true;
    };
  }, [environmentId, options]);
  const provider = choices.find((choice) => choice.instanceId === instanceId);
  const open = (value: Contracts.ManagedLaunchRecord) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId, threadId: value.threadId }),
    });
  };
  const handleRecord = (value: Contracts.ManagedLaunchRecord) => {
    setConfirmedRefusal(false);
    setRecord(value);
    setMessage(
      value.state === "accepted"
        ? "Launch accepted. Open the conversation to see the agent’s progress."
        : value.state === "failed"
          ? "The feature and session were saved, but launch intake failed. You can retry this request."
          : "The request was saved. Its intake result still needs to be checked.",
    );
    if (value.state === "accepted") {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* The saved key remains safe to inspect. */
      }
    }
  };
  const check = async () => {
    if (!saved || busy) return;
    setBusy(true);
    try {
      const result = await inspect({ environmentId, input: { operationKey: saved.operationKey } });
      if (result._tag === "Success") handleRecord(result.value);
      else
        setMessage(
          reasonLabel(result._tag === "Failure" ? failureReason(result.cause) : undefined),
        );
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (busy || !enabled) return;
    setBusy(true);
    try {
      const request =
        saved ??
        decodeLaunchInput({
          operationKey: await runtime.runPromise(
            Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
          ),
          installationID,
          workspaceID: resource.workspaceID,
          generation: resource.generation,
          revision: resource.revision,
          repositoryID,
          title,
          objective,
          modelSelection: { instanceId, model },
          runtimeMode,
        });
      // Save before transport dispatch. A dropped connection keeps the same operation key,
      // immutable scope and objective available for inspection or a retry after reload.
      localStorage.setItem(storageKey, encodeDraft(request));
      setSaved(request);
      const result = await launch({ environmentId, input: request });
      if (result._tag === "Success") {
        handleRecord(result.value);
        if (result.value.state === "accepted") open(result.value);
      } else {
        const reason = result._tag === "Failure" ? failureReason(result.cause) : undefined;
        setConfirmedRefusal(reason === "stale_context" || reason === "unavailable_provider");
        setMessage(reasonLabel(reason));
      }
    } catch {
      setMessage(
        "The request could not be saved or sent. Check its result if a launch key was already saved.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={styles["dh-launcher"]} aria-label="Launch an agent">
      <h3>Agent session</h3>
      <p>
        Start a writer in this context’s existing source tree. Choose the repository it may own.
      </p>
      {optionsError ? (
        <p role="alert">Provider choices could not be loaded. Reopen this context to try again.</p>
      ) : null}
      {!choices.length && !optionsError ? (
        <p>Waiting for configured providers. Configure and sign in to a provider in Settings.</p>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={busy || saved !== null || !enabled}>
          <label htmlFor="dh-launch-repo">Repository</label>
          <select
            id="dh-launch-repo"
            value={repositoryID}
            onChange={(event) => setRepositoryID(event.target.value)}
          >
            {resource.workspace?.repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.id}
              </option>
            ))}
          </select>
          <label htmlFor="dh-launch-provider">Provider account</label>
          <select
            id="dh-launch-provider"
            required
            value={instanceId}
            onChange={(event) => {
              setInstanceId(event.target.value);
              setModel("");
            }}
          >
            <option value="">Choose a provider</option>
            {choices.map((choice) => (
              <option key={choice.instanceId} value={choice.instanceId}>
                {choice.label}
              </option>
            ))}
          </select>
          <label htmlFor="dh-launch-model">Model</label>
          <select
            id="dh-launch-model"
            required
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value="">Choose a model</option>
            {provider?.models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          <label htmlFor="dh-launch-access">Permissions</label>
          <select
            id="dh-launch-access"
            value={runtimeMode}
            onChange={(event) =>
              setRuntimeMode(
                event.target.value === "full-access" ? "full-access" : "approval-required",
              )
            }
          >
            <option value="approval-required">Ask for approval</option>
            <option value="full-access">Full access</option>
          </select>
          <label htmlFor="dh-launch-title">Feature title</label>
          <input
            id="dh-launch-title"
            required
            maxLength={200}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <label htmlFor="dh-launch-objective">Objective</label>
          <textarea
            id="dh-launch-objective"
            required
            maxLength={16000}
            rows={4}
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
          />
        </fieldset>
        <div className={styles["dh-inspector-actions"]}>
          {record?.state === "accepted" ? (
            <button type="button" className={styles["dh-button"]} onClick={() => open(record)}>
              Open conversation
            </button>
          ) : (
            <button
              type="submit"
              className={`${styles["dh-button"]} ${styles["dh-accent"]}`}
              disabled={
                busy ||
                !enabled ||
                (!saved && (!provider || !model || !title.trim() || !objective.trim()))
              }
            >
              {busy ? "Checking launch…" : saved ? "Retry saved launch" : "Launch agent"}
            </button>
          )}
          {saved ? (
            <button
              type="button"
              className={styles["dh-button"]}
              disabled={busy}
              onClick={() => {
                void check();
              }}
            >
              Check result
            </button>
          ) : null}
          {confirmedRefusal || record?.state === "failed" ? (
            <button
              type="button"
              className={styles["dh-button"]}
              disabled={busy}
              onClick={() => {
                try {
                  localStorage.removeItem(storageKey);
                } catch {
                  setMessage(
                    "The saved request could not be cleared. Check its result before continuing.",
                  );
                  return;
                }
                setSaved(null);
                setRecord(null);
                setConfirmedRefusal(false);
                setMessage(
                  "Edit the request before launching again. Any previously saved session remains in its context history.",
                );
              }}
            >
              Edit launch request
            </button>
          ) : null}
        </div>
      </form>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
