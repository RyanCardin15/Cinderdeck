import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ModelSelection } from "@cinderdeck/contracts";
import * as Contracts from "@cinderdeck/contracts/deckhand/rpc";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { useAtomValue } from "@effect/atom-react";
import { runtime } from "../lib/runtime";
import { buildThreadRouteParams } from "../threadRoutes";
import { useAtomCommand } from "../state/use-atom-command";
import { environmentServerConfigsAtom } from "../state/server";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { readProjects } from "../state/entities";
import { resolveProjectSettings } from "@cinderdeck/shared/projectSettings";
import { workspaceChatUnavailableReason } from "@cinderdeck/shared/workspaceChat";
import { resolveDefaultProviderModelSelection } from "../providerInstances";
import { useComposerDraftStore } from "../composerDraftStore";
import { resolveChatModes } from "./chatDefaults";
import {
  inspectSessionLaunch,
  launchSession,
  sessionLaunchOptions,
  previewLaunchReview,
  confirmLaunchReview,
  refreshWorkspaces,
} from "./state";
import styles from "./sessions.module.css";

export type NewChatLauncherProps = {
  environmentId: EnvironmentId;
  installationID: string;
  resource: Contracts.IntegrationView["resources"][number];
  enabled: boolean;
  disabledReason?: string | undefined;
  compact?: boolean;
  autoOpen?: boolean;
  onOpened?: () => void;
  editReviewSkill?: boolean;
};
const decodeDraft = Schema.decodeUnknownSync(Schema.fromJsonString(Contracts.ManagedLaunchInput));
const encodeDraft = Schema.encodeSync(Schema.fromJsonString(Contracts.ManagedLaunchInput));
const decodeInput = Schema.decodeSync(Contracts.ManagedLaunchInput);
const isRpcError = Schema.is(Contracts.DeckhandRpcError);

export function NewChatLauncher({
  environmentId,
  installationID,
  resource,
  enabled,
  disabledReason,
  compact = false,
  autoOpen = false,
  onOpened,
  editReviewSkill = false,
}: NewChatLauncherProps) {
  const navigate = useNavigate();
  const settings = useEnvironmentSettings(environmentId);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const scope = `${environmentId}:${installationID}:${resource.workspaceID}`;
  const storageKey = `deckhand:launch:${scope}:${resource.generation}${editReviewSkill ? ":code-review-skill" : ""}`;
  const [initial] = useState(() => {
    try {
      const value = localStorage.getItem(storageKey);
      return { request: value ? decodeDraft(value) : null, error: false };
    } catch {
      return { request: null, error: true };
    }
  });
  const [saved, setSaved] = useState(initial.request);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const autoOpened = useRef(false);
  const [error, setError] = useState<string | null>(
    initial.error
      ? "The saved chat request could not be read. Restore browser storage before opening another chat."
      : null,
  );
  const [accepted, setAccepted] = useState<Contracts.ManagedLaunchRecord | null>(null);
  const repos = resource.workspace?.repos ?? [];
  // The first configured folder anchors the chat; the server supplies the entire workspace.
  const repositoryID = repos[0]?.id ?? "";
  const unavailableReason = !enabled
    ? (disabledReason ??
      "Waiting for a current connection to this computer. Refresh workspaces to try again.")
    : workspaceChatUnavailableReason(resource);
  const canOpen = unavailableReason === null;
  const refresh = useAtomCommand(refreshWorkspaces, { reportFailure: false });
  const launch = useAtomCommand(launchSession, { reportFailure: false });
  const inspect = useAtomCommand(inspectSessionLaunch, { reportFailure: false });
  const options = useAtomCommand(sessionLaunchOptions, { reportFailure: false });
  const previewReview = useAtomCommand(previewLaunchReview, { reportFailure: false });
  const confirmReview = useAtomCommand(confirmLaunchReview, { reportFailure: false });
  const [review, setReview] = useState<Contracts.ManagedLaunchReview | null>(null);
  const reviewContext = async (confirm: boolean) => {
    if (!saved || inFlight.current || (confirm && (!review || !enabled))) return;
    inFlight.current = true;
    setBusy(true);
    try {
      if (confirm && review) {
        const result = await confirmReview({ environmentId, input: review });
        setReview(null);
        if (result._tag === "Success")
          setError("Context updated. Retry the saved chat to open the same conversation.");
        else showFailure(result._tag === "Failure" ? result.cause : undefined);
      } else {
        const result = await previewReview({
          environmentId,
          input: { operationKey: saved.operationKey, kind: "launch" },
        });
        if (result._tag === "Success") setReview(result.value);
        else showFailure(result._tag === "Failure" ? result.cause : undefined);
      }
    } catch {
      setError("The saved context could not be reviewed. Check the result or retry the review.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const open = async (record: Contracts.ManagedLaunchRecord) => {
    setAccepted(null);
    onOpened?.();
    try {
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId, threadId: record.threadId }),
      });
      // A workspace refresh can remount this launcher while navigation settles.
      // Keep its immutable request available until the destination has opened.
      const current = localStorage.getItem(storageKey);
      if (current && decodeDraft(current).operationKey === record.operationKey)
        localStorage.removeItem(storageKey);
      setSaved(null);
    } catch {
      setAccepted(record);
      setError("The chat is ready. Open it again to continue the same conversation.");
    }
  };
  const handleResult = (record: Contracts.ManagedLaunchRecord, navigateOnAccepted: boolean) => {
    if (record.state === "accepted") {
      setReview(null);
      setAccepted(record);
      setError(null);
      if (navigateOnAccepted) void open(record);
    } else {
      setError(
        record.state === "failed"
          ? "The chat was saved but could not be opened. Retry the same request."
          : "The chat request is saved. Check its result or retry the same request.",
      );
    }
  };
  const showFailure = (cause?: Cause.Cause<unknown>) => {
    const failure = cause ? Option.getOrNull(Cause.findErrorOption(cause)) : null;
    setError(
      isRpcError(failure) && failure.reason === "stale_context"
        ? "Workspace folders or settings changed. Check the saved result before opening another chat."
        : "The chat result could not be confirmed. Check the saved result or retry the same request.",
    );
  };
  const start = async (access: "read_only" | "write" = "write") => {
    if (!canOpen || initial.error || inFlight.current || review) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      let request = saved;
      if (!request) {
        const result = await options({ environmentId, input: {} });
        if (result._tag !== "Success") {
          setError("Provider choices could not be loaded. Try opening the chat again.");
          return;
        }
        const available = result.value.filter(
          (choice) =>
            choice.readiness !== "unavailable" &&
            choice.readiness !== "sign_in_required" &&
            choice.models.length > 0 &&
            (access !== "read_only" || choice.supportsReadOnly),
        );
        const providers =
          configs
            .get(environmentId)
            ?.providers.filter((provider) =>
              available.some((choice) => choice.instanceId === provider.instanceId),
            ) ?? [];
        const project = readProjects().find(
          (candidate) =>
            candidate.environmentId === environmentId &&
            candidate.workspaceRoot === repos.find((repo) => repo.id === repositoryID)?.path,
        );
        const defaults = resolveProjectSettings(settings, project?.id ?? null, project).settings;
        const composer = useComposerDraftStore.getState();
        const remembered = composer.stickyActiveProvider
          ? composer.stickyModelSelectionByProvider[composer.stickyActiveProvider]
          : null;
        const preferred = defaults.defaultModelSelection ?? remembered;
        const selection: ModelSelection | null = resolveDefaultProviderModelSelection(
          providers,
          preferred,
        );
        if (!selection) {
          setError(
            access === "read_only"
              ? "Set up Codex in Settings to open a read-only analysis chat."
              : "Set up and sign in to a provider in Settings to open a chat.",
          );
          return;
        }
        const modes = resolveChatModes(
          environmentId,
          defaults.defaultRuntimeMode,
          settings.planModeEnabled,
        );
        const interactionMode =
          providers.find((provider) => provider.instanceId === selection.instanceId)
            ?.showInteractionModeToggle === false
            ? "default"
            : modes.interactionMode;
        request = decodeInput({
          operationKey: await runtime.runPromise(
            Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
          ),
          installationID,
          workspaceID: resource.workspaceID,
          generation: resource.generation,
          revision: resource.revision,
          repositoryID,
          title: editReviewSkill ? "Code Review Skill" : "New chat",
          objective: editReviewSkill
            ? `Read the attached Code Review Skill and explain its instructions. Help me customize it when I ask, saving requested edits to the workspace file at ${JSON.stringify(`${resource.workspace?.root ?? repos[0]?.path}/${Contracts.CODE_REVIEW_SKILL_PATH}`)}.`
            : "",
          ...(editReviewSkill ? { editReviewSkill: true } : {}),
          deferStart: !editReviewSkill,
          modelSelection: selection,
          ...(access === "read_only" ? { access } : {}),
          ...modes,
          interactionMode,
        });
        // Persist the immutable scope and key before dispatch; an interrupted
        // open retries the same chat, never allocates a second conversation.
        localStorage.setItem(storageKey, encodeDraft(request));
        setSaved(request);
      }
      const result = await launch({ environmentId, input: request });
      if (result._tag === "Success") handleResult(result.value, true);
      else showFailure(result._tag === "Failure" ? result.cause : undefined);
    } catch {
      setError(
        "The chat request could not be saved or sent. Check its result if a request is saved.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const check = async () => {
    if (!saved || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await inspect({ environmentId, input: { operationKey: saved.operationKey } });
      if (result._tag === "Success") handleResult(result.value, false);
      else {
        const failure =
          result._tag === "Failure" ? Option.getOrNull(Cause.findErrorOption(result.cause)) : null;
        if (isRpcError(failure) && failure.reason === "missing") {
          // Only a confirmed absence permits fresh defaults and checkout scope.
          localStorage.removeItem(storageKey);
          setSaved(null);
          setError("No chat was created. You can open a new chat in the current workspace.");
        } else showFailure(result._tag === "Failure" ? result.cause : undefined);
      }
    } catch {
      setError("The saved result could not be checked. Retry this check.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!autoOpen || autoOpened.current || !canOpen || !repositoryID) return;
    // A sidebar click opens once, including under StrictMode. Recovery stays explicit.
    autoOpened.current = true;
    void start();
  }, [autoOpen, canOpen, repositoryID, start]);
  const refreshContext = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await refresh({ environmentId, input: {} });
      if (result._tag !== "Success")
        setError(
          "Workspaces could not be refreshed. Check this computer’s connection in Settings → Connections.",
        );
      else setError(null);
    } catch {
      setError("Workspaces could not be refreshed. Try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <section className={compact ? styles.chatShortcut : styles.launchPrompt} aria-label="New chat">
      {!compact ? (
        <div>
          <h3>Open a chat</h3>
          <p>
            {resource.workspace?.lane?.name ?? resource.workspace?.name ?? "Workspace"} · choose
            your provider and model in the chat.
          </p>
        </div>
      ) : null}
      <div className={styles.chatActions}>
        <button
          type="button"
          className={styles.primary}
          disabled={busy || (!accepted && !canOpen) || initial.error || review !== null}
          onClick={() => (accepted ? void open(accepted) : void start())}
        >
          {busy ? "Opening…" : accepted ? "Open chat" : saved ? "Retry saved chat" : "+ New chat"}
        </button>
        {!saved && !accepted ? (
          <details className={styles.chatOptions}>
            <summary>Chat options</summary>
            <button
              type="button"
              className={styles.quiet}
              disabled={busy || !canOpen || initial.error}
              onClick={() => void start("read_only")}
            >
              Open read-only analysis chat
            </button>
          </details>
        ) : null}
        {saved ? (
          <button
            type="button"
            className={styles.quiet}
            disabled={busy}
            onClick={() => void check()}
          >
            Check result
          </button>
        ) : null}
        <Link to="/settings/general" search={{ machine: environmentId }} hash="project-defaults">
          Chat defaults
        </Link>
      </div>
      {unavailableReason ? (
        <div className={styles.scopeNote} role="status">
          <p>{unavailableReason}</p>
          <button
            type="button"
            className={styles.quiet}
            disabled={busy}
            onClick={() => void refreshContext()}
          >
            Refresh workspaces
          </button>
        </div>
      ) : null}
      {saved && error ? (
        <button
          type="button"
          className={styles.quiet}
          disabled={busy}
          onClick={() => void reviewContext(false)}
        >
          Review latest context
        </button>
      ) : null}
      {review ? (
        <div className={styles.chatReview} aria-label="Review saved chat context">
          <p>Review the workspace folders before retrying this chat.</p>
          {review.repositories.map((repo) => (
            <div key={repo.repositoryID}>
              <strong>{repo.repositoryID}</strong>
              <code>{repo.checkout.root}</code>
              <span>
                {repo.checkout.gitDirectory === repo.checkout.root
                  ? "Folder"
                  : (repo.checkout.branch ?? "Detached HEAD")}
                {repo.checkout.commit ? ` · ${repo.checkout.commit.slice(0, 12)}` : ""}
              </span>
            </div>
          ))}
          <button
            type="button"
            className={styles.quiet}
            disabled={busy || !enabled}
            onClick={() => void reviewContext(true)}
          >
            Confirm reviewed context
          </button>
          <button
            type="button"
            className={styles.quiet}
            disabled={busy}
            onClick={() => setReview(null)}
          >
            Cancel review
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="status" className={styles.scopeNote}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
