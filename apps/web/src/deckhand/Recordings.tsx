import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ClapperboardIcon,
  CircleIcon,
  GitBranchIcon,
  MonitorIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SquareIcon,
  CheckIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  Recording,
  RecordingContext,
  RecordingLogs,
  RecordingStart,
  RecordingWindow,
} from "@t3tools/contracts/deckhand/recordingsRpc";
import * as Option from "effect/Option";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { runtime } from "../lib/runtime";
import * as Schema from "effect/Schema";
import { RecordingStart as RecordingStartSchema } from "@t3tools/contracts/deckhand/recordingsRpc";
import { ProductNavigation } from "./ProductNavigation";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  useEnvironments,
  useEnvironmentHttpBaseUrl,
  usePrimaryEnvironmentId,
} from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { workspaceView } from "./state";
import {
  listRecordings,
  getRecording,
  recordingWindows,
  startRecording,
  controlRecording,
  recordingLogs,
  markRecording,
  recordingMedia,
} from "./recordingState";
import { RecordingThumbnail } from "./RecordingThumbnail";
import styles from "./recordings.module.css";
const EMPTY_CAPTURE_CONTEXTS: ReadonlyArray<{ id: string; label: string }> = [];
const decodeSavedStart = Schema.decodeUnknownSync(Schema.fromJsonString(RecordingStartSchema));
const time = (seconds: number) =>
  `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
export function RecordingsPage() {
  const search = useSearch({ from: "/_chat/recordings" });
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const environmentId = search.environment
    ? environments.find((item) => item.environmentId === search.environment)?.environmentId
    : (primary ?? environments[0]?.environmentId);
  return environmentId ? (
    <RecordingWorkspace key={environmentId} environmentId={environmentId} />
  ) : (
    <main className={styles.empty}>
      <ClapperboardIcon />
      <h1>Recordings</h1>
      <p>Connect an execution computer to review its recordings.</p>
      <Link to="/settings/connections">Manage connections</Link>
    </main>
  );
}
function RecordingWorkspace({ environmentId }: { environmentId: EnvironmentId }) {
  const search = useSearch({ from: "/_chat/recordings" });
  const result = useAtomValue(workspaceView({ environmentId, input: { offset: 0, limit: 100 } }));
  const view = Option.getOrNull(AsyncResult.value(result));
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const workspace = search.workspace ?? "";
  const resources = view?.resources.filter((item) => item.available) ?? [];
  const selected = workspace
    ? resources.find((item) => item.workspaceID === workspace)
    : resources[0];
  return (
    <div className={styles.shell}>
      <ProductNavigation
        current="recordings"
        connection={{
          label: view?.state === "connected" ? "Cinderdeck connected" : "Cinderdeck unavailable",
          connected: view?.state === "connected",
        }}
      />
      <main className={styles.page}>
        <header className={styles.pageHeader}>
          <div>
            <Link to="/workspaces">
              <ArrowLeftIcon size={15} /> Workspaces
            </Link>
            <h1>Recorded verification</h1>
            <p>Watch what happened. Follow the logs. Keep the evidence with the work.</p>
          </div>
          <label>
            Execution computer
            <select
              aria-label="Recording execution computer"
              value={environmentId}
              onChange={(event) => {
                void navigate({ to: "/recordings", search: { environment: event.target.value } });
              }}
            >
              {environments.map((item) => (
                <option key={item.environmentId} value={item.environmentId}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Workspace
            <select
              aria-label="Recording workspace"
              value={workspace || selected?.workspaceID || ""}
              onChange={(event) => {
                void navigate({
                  to: "/recordings",
                  search: {
                    environment: environmentId,
                    workspace: event.target.value,
                  },
                });
              }}
            >
              {workspace && !selected ? (
                <option value={workspace}>Requested workspace unavailable</option>
              ) : null}
              {resources.map((item) => (
                <option key={item.workspaceID} value={item.workspaceID}>
                  {item.workspace?.name ?? item.workspaceID}
                </option>
              ))}
            </select>
          </label>
        </header>
        {view?.state === "connected" && view.hello && selected ? (
          <Recordings
            key={`${environmentId}:${selected.workspaceID}:${selected.generation}:${search.recording ?? ""}`}
            environmentId={environmentId}
            context={{
              installationID: view.hello.installationID,
              workspaceID: selected.workspaceID,
              generation: selected.generation,
            }}
            initialRecordingID={search.recording}
            onSelectRecording={(recording) => {
              void navigate({
                to: "/recordings",
                search: { environment: environmentId, workspace: selected.workspaceID, recording },
              });
            }}
            captureContexts={resources.map((item) => ({
              id: item.workspaceID,
              label: item.workspace?.name ?? item.workspaceID,
            }))}
          />
        ) : (
          <section className={styles.empty}>
            <MonitorIcon />
            <h2>
              {view?.state === "connected"
                ? "No connected workspaces"
                : "Connect Cinderdeck to view recordings"}
            </h2>
            <p>
              Recordings stay on the execution computer that captured them. Select an available
              workspace to continue.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
export function Recordings({
  environmentId,
  context,
  initialRecordingID,
  buildReceiptID,
  captureContexts = EMPTY_CAPTURE_CONTEXTS,
  onSelectRecording,
}: {
  environmentId: EnvironmentId;
  context: RecordingContext;
  initialRecordingID?: string | undefined;
  buildReceiptID?: string | undefined;
  captureContexts?: ReadonlyArray<{ id: string; label: string }>;
  onSelectRecording?: (recording: string) => void;
}) {
  const list = useAtomCommand(listRecordings, { reportFailure: false });
  const get = useAtomCommand(getRecording, { reportFailure: false });
  const windows = useAtomCommand(recordingWindows, { reportFailure: false });
  const start = useAtomCommand(startRecording, { reportFailure: false });
  const control = useAtomCommand(controlRecording, { reportFailure: false });
  const logs = useAtomCommand(recordingLogs, { reportFailure: false });
  const mark = useAtomCommand(markRecording, { reportFailure: false });
  const media = useAtomCommand(recordingMedia, { reportFailure: false });
  const baseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const [items, setItems] = useState<ReadonlyArray<Recording>>([]);
  const [selectedID, select] = useState(initialRecordingID ?? "");
  const [selected, setSelected] = useState<Recording | null>(null);
  const [logView, setLogs] = useState<RecordingLogs | null>(null);
  const [mediaRevision, setMediaRevision] = useState(0);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [filter, setFilter] = useState("all");
  const [level, setLevel] = useState<"debug" | "warning" | "error">("debug");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [targets, setTargets] = useState<ReadonlyArray<RecordingWindow>>([]);
  const [title, setTitle] = useState("");
  const [windowID, setWindowID] = useState(0);
  const [captureLogs, setCaptureLogs] = useState(true);
  const [extraScopes, setExtraScopes] = useState<ReadonlyArray<string>>([]);
  const [pendingStart, setPendingStart] = useState<RecordingStart | null>(null);
  const [check, setCheck] = useState("");
  const storageKey = `deckhand-recording-start:${environmentId}:${context.installationID}:${context.workspaceID}:${context.generation}:${buildReceiptID ?? "unbound"}`;
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      const saved = decodeSavedStart(raw);
      if (
        saved.installationID !== context.installationID ||
        saved.workspaceID !== context.workspaceID ||
        saved.generation !== context.generation
      )
        throw new Error("Saved context changed");
      setPendingStart(saved);
      setTitle(saved.title);
      setWindowID(saved.windowID);
      setCreating(true);
      setTargets([
        {
          id: saved.windowID,
          app: "Saved capture target",
          title: "Review the library before retrying",
        },
      ]);
    } catch {
      setError(
        "The saved capture request could not be read. Inspect the native recording library before starting another capture.",
      );
    }
  }, [storageKey, context.installationID, context.workspaceID, context.generation]);
  const video = useRef<HTMLVideoElement>(null);
  const lastLogs = useRef(-Infinity);
  const logSequence = useRef(0);
  const requestedSeek = useRef<number | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const reload = useCallback(async () => {
    const response = await list({
      environmentId,
      input: {
        installationID: context.installationID,
        workspaceID: context.workspaceID,
        generation: context.generation,
      },
    });
    if (!alive.current) return;
    if (response._tag === "Success") {
      setItems(response.value);
      setError(null);
    } else
      setError(
        "The recording library is unavailable. Check the Cinderdeck connection and try again.",
      );
    setLoading(false);
  }, [list, environmentId, context.installationID, context.workspaceID, context.generation]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const active = items.some((item) => item.state === "recording" || item.state === "finalizing");
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [active, reload]);
  const identity = useCallback(
    (id: string) => ({
      installationID: context.installationID,
      workspaceID: context.workspaceID,
      generation: context.generation,
      recordingID: id,
    }),
    [context.installationID, context.workspaceID, context.generation],
  );
  useEffect(() => {
    const id = selectedID || items[0]?.id;
    if (!id) {
      setSelected(null);
      return;
    }
    let cancelled = false;
    setVideoUrl(null);
    setLogs(null);
    setPosition(0);
    lastLogs.current = -Infinity;
    requestedSeek.current = null;
    logSequence.current += 1;
    void get({ environmentId, input: identity(id) }).then(async (response) => {
      if (cancelled || !alive.current) return;
      if (response._tag !== "Success") {
        setSelected(null);
        setError(
          "The requested recording is unavailable in this workspace. Select another recording to continue.",
        );
        return;
      }
      setSelected(response.value);
      const requestSequence = ++logSequence.current;
      const logResponse = await logs({
        environmentId,
        input: { ...identity(id), around: 0, level: "debug" },
      });
      if (!cancelled && logSequence.current === requestSequence && logResponse._tag === "Success")
        setLogs(logResponse.value);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedID, items[0]?.id, environmentId, get, logs, identity]);
  // Refresh recording state without replacing a playing video or resetting the seek position.
  useEffect(() => {
    const updated = items.find((item) => item.id === selected?.id);
    if (updated) setSelected(updated);
  }, [items, selected?.id]);
  useEffect(() => {
    if (!selected?.playable || !baseUrl) return;
    let cancelled = false;
    void media({ environmentId, input: identity(selected.id) }).then((result) => {
      if (!cancelled && alive.current) {
        if (result._tag === "Success") setVideoUrl(new URL(result.value.path, baseUrl).toString());
        else setError("Video access is unavailable. Refresh the library to try again.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, selected?.playable, environmentId, identity, media, baseUrl, mediaRevision]);
  const refreshLogs = async (at: number, nextLevel = level) => {
    if (!selected) return;
    const requestSequence = ++logSequence.current;
    const response = await logs({
      environmentId,
      input: { ...identity(selected.id), around: at, level: nextLevel },
    });
    if (!alive.current || logSequence.current !== requestSequence) return;
    if (response._tag === "Success") setLogs(response.value);
    else
      setError(
        "The synchronized log query could not be loaded. Reconnect Cinderdeck or refresh this recording.",
      );
  };
  const applyRequestedSeek = (element: HTMLVideoElement) => {
    const at = requestedSeek.current;
    if (at === null || element.readyState < 1) return;
    if (Math.abs(element.currentTime - at) < 0.15) {
      requestedSeek.current = null;
      return;
    }
    try {
      element.currentTime = Math.min(at, Number.isFinite(element.duration) ? element.duration : at);
    } catch {
      setError("The player cannot seek to this moment yet. Reload video access and try again.");
    }
  };
  const seek = (at: number) => {
    const target = Math.max(0, Math.min(at, selected?.duration ?? at));
    requestedSeek.current = target;
    lastLogs.current = target;
    setPosition(target);
    if (video.current) applyRequestedSeek(video.current);
    void refreshLogs(target);
  };
  const openCreate = async () => {
    setCreating(true);
    setError(null);
    setBusy(true);
    const response = await windows({ environmentId, input: context });
    if (response._tag === "Success") {
      setTargets(response.value);
      if (!pendingStart) setWindowID(0);
    } else
      setError(
        "Cinderdeck could not list capture windows. Grant Screen Recording permission on the execution computer and try again.",
      );
    setBusy(false);
  };
  const begin = async () => {
    if (!title.trim() || !windowID) return;
    setBusy(true);
    setError(null);
    const input = pendingStart ?? {
      ...context,
      operationKey: await runtime.runPromise(
        Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
      ),
      ...(buildReceiptID ? { buildReceiptID } : {}),
      title: title.trim(),
      windowID,
      capturedWorkspaceIDs: captureLogs ? [context.workspaceID, ...extraScopes] : [],
    };
    try {
      localStorage.setItem(storageKey, JSON.stringify(input));
    } catch {
      setError(
        "This browser cannot save the capture request. Enable local storage before starting a recording.",
      );
      setBusy(false);
      return;
    }
    setPendingStart(input);
    const result = await start({ environmentId, input });
    if (result._tag === "Success") {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        setError(
          "The recording started, but this browser could not clear its saved request. Reloading will reconcile the same recording.",
        );
      }
      setPendingStart(null);
      setCreating(false);
      select(result.value.id);
      setSelected(result.value);
      await reload();
    } else
      setError(
        "Capture did not confirm. Retry the saved request or inspect the library before starting another recording.",
      );
    setBusy(false);
  };
  const act = async (action: "stop" | "pause" | "resume") => {
    if (!selected) return;
    setBusy(true);
    const response = await control({ environmentId, input: { ...identity(selected.id), action } });
    if (response._tag === "Success") {
      setSelected(response.value);
      await reload();
    } else
      setError(
        "Capture control was refused. Confirm that this session owns the recording and Cinderdeck is connected.",
      );
    setBusy(false);
  };
  const annotate = async (outcome: "pass" | "fail" | "info") => {
    if (!selected || !check.trim()) return;
    setBusy(true);
    const response = await mark({
      environmentId,
      input: { ...identity(selected.id), label: check.trim(), outcome },
    });
    if (response._tag === "Success") {
      setSelected(response.value);
      setCheck("");
      await reload();
    } else setError("The marker could not be saved.");
    setBusy(false);
  };
  const markerGroups: Array<{
    t: number;
    outcome: string;
    markers: Array<Recording["markers"][number]>;
  }> = [];
  for (const marker of [...(selected?.markers ?? [])].sort((left, right) => left.t - right.t)) {
    const previous = markerGroups.at(-1);
    if (previous && (marker.t - previous.t) / Math.max(selected?.duration ?? 1, 1) < 0.055) {
      previous.markers.push(marker);
      if (marker.outcome === "fail") previous.outcome = "fail";
    } else markerGroups.push({ t: marker.t, outcome: marker.outcome ?? "info", markers: [marker] });
  }
  const visible = items.filter(
    (item) =>
      filter === "all" ||
      (filter === "active"
        ? ["recording", "finalizing"].includes(item.state)
        : item.checkOutcome === filter),
  );
  return (
    <section className={styles.root} aria-label="Recording library">
      <div className={styles.toolbar}>
        <div className={styles.filters}>
          {["all", "active", "passed", "failed"].map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {value === "all"
                ? "All recordings"
                : value === "active"
                  ? "In progress"
                  : value === "passed"
                    ? "Passed checks"
                    : "Failed checks"}
            </button>
          ))}
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            onClick={() => {
              setMediaRevision((value) => value + 1);
              void reload();
            }}
            aria-label="Refresh recordings"
          >
            <RefreshCwIcon size={15} />
          </button>
          <button
            type="button"
            className={styles.accent}
            disabled={busy || active}
            onClick={() => void openCreate()}
          >
            <PlusIcon size={15} /> Record verification
          </button>
        </div>
      </div>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {creating ? (
        <form
          className={styles.create}
          onSubmit={(event) => {
            event.preventDefault();
            void begin();
          }}
        >
          <div>
            <h3>Record a window</h3>
            <p>
              The primary lane stays attached to this recording. Choose which workspace logs to
              capture separately.
            </p>
          </div>
          <label>
            Recording title
            <input
              value={pendingStart?.title ?? title}
              disabled={!!pendingStart}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Checkout recovery verification"
              maxLength={200}
              required
            />
          </label>
          <label>
            Window on the execution computer
            <select
              value={pendingStart?.windowID ?? windowID}
              disabled={!!pendingStart}
              onChange={(event) => setWindowID(Number(event.target.value))}
              required
            >
              {!pendingStart ? (
                <option value={0} disabled>
                  {targets.length ? "Choose a capture window" : "No capture windows available"}
                </option>
              ) : null}
              {pendingStart && !targets.some((target) => target.id === pendingStart.windowID) ? (
                <option value={pendingStart.windowID}>
                  Saved target #{pendingStart.windowID} · reconcile original request
                </option>
              ) : null}
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.app} · {target.title || "Untitled window"}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={pendingStart ? pendingStart.capturedWorkspaceIDs.length > 0 : captureLogs}
              disabled={!!pendingStart}
              onChange={(event) => setCaptureLogs(event.target.checked)}
            />{" "}
            Capture this workspace’s service and run logs
          </label>
          {captureLogs && captureContexts.some((item) => item.id !== context.workspaceID) ? (
            <fieldset className={styles.scopeOptions}>
              <legend>Include additional workspace logs</legend>
              {captureContexts
                .filter((item) => item.id !== context.workspaceID)
                .slice(0, 15)
                .map((item) => (
                  <label key={item.id} className={styles.checkbox}>
                    <input
                      type="checkbox"
                      disabled={!!pendingStart}
                      checked={
                        pendingStart
                          ? pendingStart.capturedWorkspaceIDs.includes(item.id)
                          : extraScopes.includes(item.id)
                      }
                      onChange={(event) =>
                        setExtraScopes((current) =>
                          event.target.checked
                            ? [...current, item.id]
                            : current.filter((id) => id !== item.id),
                        )
                      }
                    />
                    {item.label}
                  </label>
                ))}
            </fieldset>
          ) : null}
          <div className={styles.actions}>
            <button type="button" onClick={() => setCreating(false)}>
              Close
            </button>
            <button className={styles.accent} disabled={busy || !windowID || !title.trim()}>
              {pendingStart ? "Retry saved request" : "Start recording"}
            </button>
          </div>
        </form>
      ) : null}
      {loading ? (
        <div className={styles.empty}>
          <ClapperboardIcon />
          <p>Loading the recording library…</p>
        </div>
      ) : !items.length ? (
        <div className={styles.empty}>
          <ClapperboardIcon size={36} />
          <h2>Your evidence starts here</h2>
          <p>
            Record a real application window with synchronized workspace logs, then review the
            result alongside captured repository revisions.
          </p>
          <button type="button" className={styles.accent} onClick={() => void openCreate()}>
            Record your first verification
          </button>
        </div>
      ) : (
        <div className={styles.layout}>
          <div className={styles.viewer}>
            {selected ? (
              <>
                <header className={styles.recordingHeader}>
                  <div>
                    <h2>{selected.title}</h2>
                    <p>
                      Recorded by {selected.actor} · {new Date(selected.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <span
                    className={styles.badge}
                    data-state={selected.state === "recording" ? "active" : selected.checkOutcome}
                  >
                    <CircleIcon size={10} />
                    {selected.state === "recording"
                      ? selected.paused
                        ? "Paused"
                        : "Recording"
                      : selected.state === "finalizing"
                        ? "Saving recording"
                        : selected.checkOutcome === "unverified"
                          ? "No checks recorded"
                          : selected.checkOutcome === "passed"
                            ? "Recorded checks passed"
                            : "Recorded checks failed"}
                  </span>
                </header>
                <div className={styles.player}>
                  {videoUrl ? (
                    <video
                      ref={video}
                      src={videoUrl}
                      controls
                      preload="metadata"
                      aria-label={selected.title}
                      onError={() =>
                        setError(
                          "Video could not be played. Refresh the recording to renew its media access.",
                        )
                      }
                      onLoadedMetadata={(event) => {
                        if (requestedSeek.current !== null) applyRequestedSeek(event.currentTarget);
                        else if (position > 0 && Number.isFinite(event.currentTarget.duration))
                          event.currentTarget.currentTime = Math.min(
                            position,
                            event.currentTarget.duration,
                          );
                      }}
                      onCanPlay={(event) => applyRequestedSeek(event.currentTarget)}
                      onSeeked={(event) => {
                        const target = requestedSeek.current;
                        if (
                          target !== null &&
                          Math.abs(event.currentTarget.currentTime - target) < 0.15
                        )
                          requestedSeek.current = null;
                        if (requestedSeek.current === null)
                          setPosition(event.currentTarget.currentTime);
                      }}
                      onTimeUpdate={(event) => {
                        const at = event.currentTarget.currentTime;
                        if (
                          requestedSeek.current !== null &&
                          Math.abs(at - requestedSeek.current) >= 0.15
                        )
                          return;
                        requestedSeek.current = null;
                        setPosition(at);
                        if (Math.abs(at - lastLogs.current) >= 1) {
                          lastLogs.current = at;
                          void refreshLogs(at);
                        }
                      }}
                    />
                  ) : (
                    <div className={styles.videoEmpty}>
                      <ClapperboardIcon size={40} />
                      <h3>
                        {selected.state === "recording"
                          ? "Capture is in progress"
                          : selected.state === "finalizing"
                            ? "Saving the video and timeline"
                            : "Video unavailable"}
                      </h3>
                      <p>
                        {selected.detail ??
                          (selected.state === "recording"
                            ? "Playback is available after you stop the recording."
                            : "The source video may have been moved or removed.")}
                      </p>
                    </div>
                  )}
                </div>
                {selected.controlAllowed ? (
                  <div className={styles.actions}>
                    <button
                      disabled={busy}
                      type="button"
                      onClick={() => void act(selected.paused ? "resume" : "pause")}
                    >
                      {selected.paused ? <PlayIcon size={15} /> : <PauseIcon size={15} />}{" "}
                      {selected.paused ? "Resume capture" : "Pause capture"}
                    </button>
                    <button
                      disabled={busy}
                      type="button"
                      className={styles.stop}
                      onClick={() => void act("stop")}
                    >
                      <SquareIcon size={14} /> Stop and save
                    </button>
                  </div>
                ) : null}
                <div className={styles.timeline} aria-label="Recorded markers">
                  <div className={styles.timelineTrack} />
                  {markerGroups.map((group) => (
                    <button
                      key={group.markers[0]!.id}
                      type="button"
                      style={{
                        left: `${Math.max(1.5, Math.min(98.5, (group.t / Math.max(selected.duration, 1)) * 100))}%`,
                      }}
                      data-outcome={group.outcome}
                      onClick={() => seek(group.t)}
                      aria-label={`Seek to ${time(group.t)} · ${group.markers.length} recorded event${group.markers.length === 1 ? "" : "s"}`}
                    >
                      <span />
                      {group.markers.length > 1 ? (
                        <small>{group.markers.length} events</small>
                      ) : null}
                    </button>
                  ))}
                  <span className={styles.timelineStart}>00:00</span>
                  <span className={styles.timelineEnd}>{time(selected.duration)}</span>
                </div>
                {selected.markers.length ? (
                  <nav className={styles.markerList} aria-label="Recording event list">
                    {selected.markers.map((marker) => (
                      <button
                        key={marker.id}
                        type="button"
                        data-outcome={marker.outcome ?? "info"}
                        onClick={() => seek(marker.t)}
                        aria-label={`Seek to ${marker.label} at ${time(marker.t)}`}
                      >
                        <time>{time(marker.t)}</time>
                        <span>{marker.label}</span>
                      </button>
                    ))}
                  </nav>
                ) : null}
                <section className={styles.logs}>
                  <header>
                    <h3>Logs at {time(position)}</h3>
                    <select
                      aria-label="Minimum log level"
                      value={level}
                      onChange={(event) => {
                        const value = event.target.value as typeof level;
                        setLevel(value);
                        void refreshLogs(position, value);
                      }}
                    >
                      <option value="debug">All output</option>
                      <option value="warning">Warnings and errors</option>
                      <option value="error">Errors only</option>
                    </select>
                  </header>
                  <div className={styles.logLines}>
                    {logView?.lines.length ? (
                      logView.lines.map((line) => (
                        <button
                          type="button"
                          key={line.id ?? `${line.source}:${line.t}:${line.text}`}
                          data-level={line.level}
                          onClick={() => seek(line.t)}
                        >
                          <time>{line.time}</time>
                          <span>{line.source}</span>
                          <code>{line.text}</code>
                          {line.offscreen ? <small>Offscreen</small> : null}
                        </button>
                      ))
                    ) : (
                      <p>No captured log lines near this moment.</p>
                    )}
                  </div>
                  <footer>
                    {selected.lineCount.toLocaleString()} captured lines · {selected.errorCount}{" "}
                    observed errors · {selected.warningCount} warnings
                  </footer>
                </section>
              </>
            ) : (
              <div className={styles.empty}>Select a recording to review it.</div>
            )}
          </div>
          <aside className={styles.inspector}>
            <section className={styles.card}>
              <h3>
                Recordings <span>{visible.length}</span>
              </h3>
              <div className={styles.library}>
                {visible.length ? (
                  visible.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      aria-pressed={selected?.id === item.id}
                      onClick={() => {
                        select(item.id);
                        onSelectRecording?.(item.id);
                      }}
                    >
                      <span className={styles.thumbnail}>
                        <RecordingThumbnail
                          environmentId={environmentId}
                          context={context}
                          recordingID={item.id}
                          playable={item.playable}
                          title={item.title}
                        />
                      </span>
                      <span>
                        <strong>{item.title}</strong>
                        <small>
                          {time(item.duration)} · {item.state}
                        </small>
                        <em data-outcome={item.checkOutcome}>
                          {item.checkOutcome === "unverified"
                            ? "No recorded checks"
                            : item.checkOutcome === "passed"
                              ? "Checks passed"
                              : "Checks failed"}
                        </em>
                      </span>
                    </button>
                  ))
                ) : (
                  <p>No recordings match this filter.</p>
                )}
              </div>
            </section>
            {selected ? (
              <>
                <section className={styles.card}>
                  <h3>Captured context</h3>
                  <dl>
                    <dt>Primary lane</dt>
                    <dd>{selected.primaryWorkspaceID ?? "Not associated"}</dd>
                    <dt>Captured logs</dt>
                    <dd>
                      {selected.capturedWorkspaceNames.length
                        ? selected.capturedWorkspaceNames.join(", ")
                        : selected.capturedWorkspaceIDs.length
                          ? selected.capturedWorkspaceIDs.join(", ")
                          : "No workspace logs"}
                    </dd>
                    <dt>Capture target</dt>
                    <dd>{selected.capture ?? "Unknown"}</dd>
                  </dl>
                  {selected.repositories.map((repo) => (
                    <div
                      className={styles.revision}
                      key={`${repo.workspaceID}:${repo.repositoryID}`}
                    >
                      <GitBranchIcon size={14} />
                      <div>
                        <strong>{repo.repositoryID}</strong>
                        <span>
                          {repo.branch} · {repo.head?.slice(0, 10) ?? "Unknown revision"}
                        </span>
                        <small>
                          {repo.changedFiles
                            ? `${repo.changedFiles} changed files at capture`
                            : "No changed files recorded"}
                        </small>
                      </div>
                    </div>
                  ))}
                  <p className={styles.provenance}>
                    Captured repository state describes the checkout. Served build identity has not
                    been verified.
                  </p>
                </section>
                <section className={styles.card}>
                  <h3>Add a recorded check</h3>
                  <p>
                    Save the outcome you observed. Checks are added at the current capture time, or
                    at the end of a saved recording.
                  </p>
                  <input
                    aria-label="Check label"
                    value={check}
                    maxLength={500}
                    onChange={(event) => setCheck(event.target.value)}
                    placeholder="Cart survives payment retry"
                  />
                  <div className={styles.actions}>
                    <button
                      type="button"
                      disabled={busy || !check.trim()}
                      onClick={() => void annotate("pass")}
                    >
                      <CheckIcon size={15} /> Pass
                    </button>
                    <button
                      type="button"
                      disabled={busy || !check.trim()}
                      onClick={() => void annotate("fail")}
                    >
                      <XIcon size={15} /> Fail
                    </button>
                    <button
                      type="button"
                      disabled={busy || !check.trim()}
                      onClick={() => void annotate("info")}
                    >
                      Note
                    </button>
                  </div>
                </section>
              </>
            ) : null}
          </aside>
        </div>
      )}
    </section>
  );
}
