import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRightIcon, FilmIcon, ImageIcon, SendIcon } from "lucide-react";
import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type EnvironmentId,
  type CapturedPromptFile,
  type CapturePromptSource,
  type ProviderInstanceId,
  type ThreadId,
} from "@cinderdeck/contracts";
import {
  wasBootstrapThreadDeleted,
  wasBootstrapThreadNotCreated,
} from "@cinderdeck/client-runtime/errors";
import { deriveThreadTitleSeed } from "@cinderdeck/client-runtime/operations";
import { squashAtomCommandFailure } from "@cinderdeck/client-runtime/state/runtime";
import { resolveProjectSettings } from "@cinderdeck/shared/projectSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { fileAttachmentCapabilityBlockReason } from "../chat/composerAttachmentFiles";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseAttachmentUpload,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { compressImageToByteLimit } from "../../lib/imageCompression";
import { newMessageId, newThreadId, randomUUID } from "../../lib/utils";
import { prepareVideoFirstFrame } from "../../lib/videoFirstFrame";
import { providerInstanceEntriesFor, isProviderInstancePickerReady } from "../../providerInstances";
import { useEnvironmentProviders } from "../../state/environments";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { threadEnvironment } from "../../state/threads";
import { buildThreadRouteParams } from "../../threadRoutes";
import { DEFAULT_INTERACTION_MODE } from "../../types";
import { openCommandPalette } from "../../commandPaletteBus";
import { resolveCapturePromptModels } from "./capturePromptModels";
import { readCapturePromptPresets, type CapturePromptPresets } from "./capturePromptPresets";

export type PromptCapture = CapturePromptSource;
export interface OpenCapturePrompt {
  readonly capture: PromptCapture;
  readonly load: Promise<{ file: File; preferences: CapturePromptPresets } | { error: string }>;
}

const selectClass = "h-9 w-full min-w-0 truncate rounded-lg border bg-background px-2 text-sm";
type ChoiceField = "project" | "provider" | `model:${ProviderInstanceId}`;
const storageKey = (environmentId: EnvironmentId, field: ChoiceField) =>
  `cinderdeck:capture-prompt:${environmentId}:${field}`;

export function CapturePromptDialog({
  request,
  environmentId,
  onClose,
}: {
  readonly request: OpenCapturePrompt;
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
}) {
  const { capture } = request;
  const navigate = useNavigate();
  const settings = useEnvironmentSettings(environmentId);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const config = useServerConfigs().get(environmentId);
  const availableProviders = useEnvironmentProviders().get(environmentId) ?? [];
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [projectID, setProject] = useState(() =>
    localStorage.getItem(storageKey(environmentId, "project")),
  );
  const [providerID, setProvider] = useState(() =>
    localStorage.getItem(storageKey(environmentId, "provider")),
  );
  const [modelChoices, setModelChoices] = useState<ReadonlyMap<ProviderInstanceId, string>>(
    new Map(),
  );
  const [loaded, setLoaded] = useState<{
    file: File;
    url: string;
    preferences: CapturePromptPresets;
  } | null>(null);
  const [editedPrompt, setPrompt] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [possibleThread, setPossibleThread] = useState<ThreadId | null>(null);
  const submitting = useRef(false);
  const promptField = useRef<HTMLTextAreaElement>(null);
  const isVideo = capture.mimeType.startsWith("video/");
  const project = projects.find((entry) => entry.id === projectID) ?? projects[0];
  const projectId = project?.id ?? null;
  const defaults = resolveProjectSettings(settings, projectId, project).settings;
  const providers = providerInstanceEntriesFor(availableProviders, settings, projectId).filter(
    isProviderInstancePickerReady,
  );
  const provider =
    providers.find((entry) => entry.instanceId === providerID) ??
    providers.find((entry) => entry.instanceId === defaults.defaultModelSelection?.instanceId) ??
    providers[0];
  const { options: models, selection: modelSelection } = resolveCapturePromptModels({
    provider,
    settings,
    projectDefault: defaults.defaultModelSelection,
    rememberedModel: provider
      ? (modelChoices.get(provider.instanceId) ??
        localStorage.getItem(storageKey(environmentId, `model:${provider.instanceId}`)))
      : null,
  });
  const controlsLocked = busy || possibleThread !== null;
  const preferences = loaded?.preferences;
  const defaultPreset = preferences?.presets.find((entry) => entry.id === preferences.defaultID);
  const prompt = editedPrompt ?? defaultPreset?.prompt ?? "";
  const capabilities = config?.environment.capabilities;
  const attachmentError =
    loaded &&
    fileAttachmentCapabilityBlockReason({
      attachmentUploadsCapabilityKnown: config !== undefined,
      supportsAttachmentUploads: capabilities?.attachmentUploads === true,
      maxFileAttachmentBytes: capabilities?.fileAttachments?.maxUploadBytes ?? null,
      files: isVideo ? [{ name: loaded.file.name, sizeBytes: loaded.file.size }] : [],
    });
  const canSend = Boolean(
    loaded &&
    project &&
    provider &&
    modelSelection &&
    prompt.trim() &&
    !busy &&
    !possibleThread &&
    capabilities?.attachmentUploads &&
    !attachmentError,
  );

  // oxlint-disable-next-line cinderdeck/no-unreasoned-state-sync -- Own the native capture preview URL until this dialog unmounts.
  useEffect(() => {
    let cancelled = false;
    let url: string | undefined;
    void request.load.then((result) => {
      if (cancelled) return;
      if ("error" in result) {
        setError(result.error);
      } else {
        url = URL.createObjectURL(result.file);
        setLoaded({ ...result, url });
      }
    });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [request]);

  const openThread = async (threadId: ThreadId) => {
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId, threadId }),
    });
    onClose();
  };

  async function send(createdAt: string) {
    if (submitting.current || !canSend || !loaded || !project || !modelSelection) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    const uploadID = randomUUID();
    const threadId = newThreadId();
    let releaseUpload = true;
    try {
      const file = loaded.file;
      const common = {
        id: uploadID,
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
      };
      const attachment = isVideo
        ? { ...common, type: "file" as const }
        : { ...common, type: "image" as const, previewUrl: loaded.url };
      startAttachmentUpload({ environmentId, image: attachment });
      await awaitAttachmentUploads([uploadID]);
      const attachments = getUploadedAttachments({ environmentId, images: [attachment] });
      if (!attachments) {
        const upload = readAttachmentUpload(uploadID);
        throw new Error(
          upload?.status === "failed" ? upload.reason : "The capture could not be uploaded.",
        );
      }
      const text = prompt.trim();
      const title = deriveThreadTitleSeed({ text, attachments });
      const runtimeMode = defaults.defaultRuntimeMode;
      const interactionMode = DEFAULT_INTERACTION_MODE;
      rememberChoice("project", project.id);
      rememberChoice("provider", modelSelection.instanceId);
      // Once dispatch is possible, preserve its destination until the server
      // confirms whether it created the thread. A retry must never duplicate it.
      setPossibleThread(threadId);
      releaseUpload = false;
      const result = await startTurn({
        environmentId,
        input: {
          threadId,
          message: { messageId: newMessageId(), role: "user", text, attachments },
          titleSeed: title,
          modelSelection,
          runtimeMode,
          interactionMode,
          createdAt,
          bootstrap: {
            createThread: {
              projectId: project.id,
              title,
              modelSelection,
              runtimeMode,
              interactionMode,
              branch: null,
              worktreePath: null,
              createdAt,
            },
          },
        },
      });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        if (wasBootstrapThreadNotCreated(failure) || wasBootstrapThreadDeleted(failure)) {
          releaseUpload = true;
          setPossibleThread(null);
        }
        throw failure;
      }
      releaseUpload = true;
      await openThread(threadId);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "The capture prompt could not be sent.",
      );
    } finally {
      if (releaseUpload) releaseAttachmentUpload(uploadID);
      submitting.current = false;
      setBusy(false);
    }
  }

  function rememberChoice(field: ChoiceField, value: string) {
    localStorage.setItem(storageKey(environmentId, field), value);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting.current) onClose();
      }}
    >
      <DialogPopup className="max-w-[31rem]" showCloseButton={!busy} initialFocus={promptField}>
        <DialogHeader>
          <DialogTitle>Ask about this capture</DialogTitle>
          <DialogDescription>Send it to a new agent thread.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex items-center gap-3 rounded-xl border bg-muted/40 p-2">
            <div className="grid h-14 w-24 shrink-0 place-items-center overflow-hidden rounded-md bg-muted text-muted-foreground">
              {loaded ? (
                isVideo ? (
                  <video
                    aria-label="Recording preview"
                    className="h-full w-full object-cover"
                    preload="auto"
                    muted
                    src={loaded.url}
                    onLoadedMetadata={(event) => prepareVideoFirstFrame(event.currentTarget)}
                  />
                ) : (
                  <img
                    alt="Captured screenshot"
                    className="h-full w-full object-cover"
                    src={loaded.url}
                  />
                )
              ) : isVideo ? (
                <FilmIcon size={18} />
              ) : (
                <ImageIcon size={18} />
              )}
            </div>
            <div className="min-w-0">
              <p className="line-clamp-2 break-all text-sm font-medium">{capture.name}</p>
              <p className="text-xs text-muted-foreground">
                {isVideo || capture.mimeType === "image/gif" ? "Screen recording" : "Screenshot"}
                {loaded ? " · Attached" : error ? "" : " · Loading…"}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-[minmax(0,0.75fr)_minmax(0,1.3fr)_minmax(0,1fr)] gap-3">
            <label className="grid min-w-0 gap-1.5 text-xs font-medium">
              Project
              <select
                className={selectClass}
                value={project?.id ?? ""}
                disabled={!project || controlsLocked}
                onChange={(event) => {
                  setProject(event.target.value);
                  rememberChoice("project", event.target.value);
                }}
              >
                {!project ? <option value="">No local projects</option> : null}
                {projects.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-1.5 text-xs font-medium">
              Provider
              <select
                className={selectClass}
                value={provider?.instanceId ?? ""}
                disabled={!provider || controlsLocked}
                onChange={(event) => {
                  setProvider(event.target.value);
                  rememberChoice("provider", event.target.value);
                }}
              >
                {!provider ? (
                  <option value="">{config ? "No ready providers" : "Loading providers…"}</option>
                ) : null}
                {providers.map((entry) => (
                  <option key={entry.instanceId} value={entry.instanceId}>
                    {entry.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 gap-1.5 text-xs font-medium">
              Model
              <select
                className={selectClass}
                value={modelSelection?.model ?? ""}
                disabled={models.length < 2 || controlsLocked}
                onChange={(event) => {
                  if (!provider) return;
                  const model = event.target.value;
                  setModelChoices((choices) => new Map(choices).set(provider.instanceId, model));
                  rememberChoice(`model:${provider.instanceId}`, model);
                }}
              >
                {!modelSelection ? <option value="">No models available</option> : null}
                {models.map((entry) => (
                  <option key={entry.slug} value={entry.slug}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {preferences?.presets.length ? (
            <div className="flex flex-wrap gap-1.5" aria-label="Prompt presets">
              {preferences.presets.map((preset) => (
                <Button
                  key={preset.id}
                  size="xs"
                  variant={prompt === preset.prompt ? "secondary" : "outline"}
                  disabled={controlsLocked}
                  aria-pressed={prompt === preset.prompt}
                  onClick={() => {
                    setPrompt(preset.prompt);
                    promptField.current?.focus();
                  }}
                >
                  {preset.title}
                </Button>
              ))}
            </div>
          ) : null}
          <Textarea
            ref={promptField}
            aria-label="Capture prompt"
            placeholder="What should the agent look at?"
            rows={4}
            maxLength={4000}
            disabled={controlsLocked}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.metaKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send(new Date().toISOString());
              }
            }}
          />
          {error || attachmentError ? (
            <p role="alert" className="text-sm text-destructive">
              {error || attachmentError}
            </p>
          ) : null}
          {!project && config ? (
            <Button
              variant="link"
              onClick={() => {
                onClose();
                openCommandPalette({ open: "add-project" });
              }}
            >
              Add a local project
            </Button>
          ) : !provider && config ? (
            <Link to="/settings/providers" onClick={onClose} className="text-sm underline">
              Set up a provider
            </Link>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {possibleThread && !busy ? (
            <Button
              onClick={() =>
                void openThread(possibleThread).catch(() =>
                  setError("The thread could not be opened."),
                )
              }
            >
              Open thread <ArrowUpRightIcon />
            </Button>
          ) : (
            <Button disabled={!canSend} onClick={() => void send(new Date().toISOString())}>
              <SendIcon /> {busy ? "Sending…" : "Send to agent"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export async function preparePromptCapture(result: CapturedPromptFile): OpenCapturePrompt["load"] {
  if ("error" in result) return { error: result.error };
  const { source, bytes } = result;
  try {
    const settings = window.desktopBridge?.capturePrompt?.settings().catch(() => null);
    let file = new File([new Uint8Array(bytes)], source.name, { type: source.mimeType });
    if (file.type.startsWith("image/")) {
      const prepared = await compressImageToByteLimit(file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
      if (!prepared.ok)
        throw new Error("The screenshot could not be prepared. Try a smaller capture.");
      file = prepared.file;
    }
    return { file, preferences: readCapturePromptPresets((await settings)?.presets) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The capture could not be opened." };
  }
}
