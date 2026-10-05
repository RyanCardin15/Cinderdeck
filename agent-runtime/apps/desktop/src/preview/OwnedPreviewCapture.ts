// @effect-diagnostics nodeBuiltinImport:off - Main exclusively owns encoder output and loopback private requests.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as C from "@cinderdeck/contracts/deckhand/ownedPreviewRpc";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@cinderdeck/contracts";
import { webContents } from "electron";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as Pool from "../backend/DesktopBackendPool.ts";
import * as Manager from "./Manager.ts";
import { reloadOwnedPreview } from "./OwnedPreviewLoad.ts";
import { createOwnedPreviewEncoder } from "./OwnedPreviewEncoder.ts";
const decodeStatus = Schema.decodeUnknownEffect(C.OwnedPreviewStatus);
const isCaptureError = Schema.is(C.OwnedPreviewError);
const fail = (reason: string) => new C.OwnedPreviewError({ reason });
type Active = {
  intent: C.OwnedPreviewIntent;
  target: C.OwnedPreviewTarget;
  encoder: Awaited<ReturnType<typeof createOwnedPreviewEncoder>>;
  status: C.OwnedPreviewStatus;
  invalidation: string | null;
  cleanup: () => void;
  lastFrame: number;
  loaded: Awaited<ReturnType<typeof reloadOwnedPreview>>;
};
export class OwnedPreviewCapture extends Context.Service<
  OwnedPreviewCapture,
  {
    readonly start: (
      input: C.OwnedPreviewIntent & { tabID: string },
    ) => Effect.Effect<C.OwnedPreviewStatus, C.OwnedPreviewError>;
    readonly stop: (captureKey: string) => Effect.Effect<C.OwnedPreviewStatus, C.OwnedPreviewError>;
  }
>()("@cinderdeck/desktop/preview/OwnedPreviewCapture") {}
export const layer = Layer.effect(
  OwnedPreviewCapture,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const pool = yield* Pool.DesktopBackendPool;
    const httpClient = yield* HttpClient.HttpClient;
    const manager = yield* Manager.PreviewManager;
    const context = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(context);
    const mutex = yield* Semaphore.make(1);
    let active: Active | null = null;
    const request = (action: string, input: object) =>
      Effect.gen(function* () {
        const instances = yield* pool.list;
        const primary = instances.find((instance) => instance.id === PRIMARY_LOCAL_ENVIRONMENT_ID);
        const config = primary ? yield* primary.currentConfig : Option.none();
        if (
          Option.isNone(config) ||
          !config.value.bootstrap.desktopCaptureToken ||
          !["127.0.0.1", "localhost", "[::1]"].includes(config.value.httpBaseUrl.hostname)
        )
          return yield* fail("local_desktop_backend_required");
        const url = new URL("/api/deckhand/owned-preview", config.value.httpBaseUrl);
        const key = config.value.bootstrap.desktopCaptureToken;
        const body = yield* encodeRequest({ action, input }).pipe(
          Effect.mapError(() => fail("invalid_private_request")),
        );
        const response = yield* httpClient
          .execute(
            HttpClientRequest.post(url).pipe(
              HttpClientRequest.setHeader("x-deckhand-capture-key", key),
              HttpClientRequest.bodyText(body, "application/json"),
            ),
          )
          .pipe(
            Effect.mapError(() => fail("private_backend_unavailable")),
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () => Effect.fail(fail("private_backend_timeout")),
            }),
          );
        if (response.status !== 200) return yield* fail("private_backend_refused");
        const raw = yield* response.json.pipe(
          Effect.mapError(() => fail("invalid_private_response")),
        );
        return yield* decodeStatus(raw).pipe(
          Effect.mapError(() => fail("invalid_private_response")),
        );
      });
    const privateIdentity = (intent: C.OwnedPreviewIntent) => ({
      captureKey: intent.captureKey,
      token: intent.token,
    });
    yield* manager.subscribeRecordingFrames((frame) =>
      Effect.sync(() => {
        const value = active;
        if (!value || value.target.tabID !== frame.tabId) return;
        const now = performance.now();
        if (now - value.lastFrame < 80) return;
        value.lastFrame = now;
        value.encoder.frame(frame.data);
      }),
    );
    const start: OwnedPreviewCapture["Service"]["start"] = (input) => {
      let began = false;
      return mutex.withPermit(
        Effect.gen(function* () {
          if (active) {
            if (
              active.intent.captureKey === input.captureKey &&
              active.intent.token === input.token &&
              active.target.tabID === input.tabID
            )
              return active.status;
            return yield* fail("another_owned_capture_active");
          }
          const prepared = yield* request("get", privateIdentity(input));
          if (prepared.state !== "prepared" || !prepared.binding)
            return yield* fail("fresh_capture_intent_required");
          const previous = yield* manager
            .ownedCaptureTarget(input.tabID)
            .pipe(Effect.mapError(() => fail("owned_browser_target_unavailable")));
          const wc = webContents.fromId(previous.webContentsID);
          if (!wc || wc.isDestroyed()) return yield* fail("owned_browser_target_unavailable");
          const loaded = yield* Effect.tryPromise({
            try: () => reloadOwnedPreview(wc, previous, prepared.binding!),
            catch: () => fail("fresh_declared_artifact_required"),
          });
          try {
            const target = yield* manager
              .ownedCaptureTarget(input.tabID)
              .pipe(Effect.mapError(() => fail("owned_browser_target_unavailable")));
            if (target.documentID !== loaded.documentID || loaded.invalidation())
              return yield* fail("target_changed_during_reload");
            const outputPath = environment.path.join(
              environment.browserArtifactsDir,
              `owned-preview-${NodeCrypto.randomUUID()}.video`,
            );
            yield* Effect.tryPromise({
              try: () => NodeFSP.mkdir(environment.browserArtifactsDir, { recursive: true }),
              catch: () => fail("output_unavailable"),
            });
            const status = yield* request("begin", {
              ...privateIdentity(input),
              target,
              consumedArtifactSHA256: loaded.consumedArtifactSHA256,
              consumedArtifactURL: loaded.consumedArtifactURL,
              clientMonotonicMs: Math.floor(performance.now()),
            });
            if (status.state !== "capturing") return status;
            began = true;
            let value: Active | null = null;
            const invalidate = (reason: string) => {
              if (value) value.invalidation ??= reason;
            };
            const navigate = (
              event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
            ) => {
              if (event.isMainFrame) invalidate("Browser navigated during capture");
            };
            const destroyed = () => invalidate("Browser target was destroyed");
            const detached = () => invalidate("Browser CDP capture detached");
            wc.on("did-start-navigation", navigate);
            wc.on("destroyed", destroyed);
            wc.debugger.on("detach", detached);
            const cleanup = () => {
              wc.off("did-start-navigation", navigate);
              wc.off("destroyed", destroyed);
              wc.debugger.off("detach", detached);
            };
            try {
              const encoder = yield* Effect.tryPromise({
                try: () =>
                  createOwnedPreviewEncoder({
                    preload: environment.path.join(
                      environment.dirname,
                      "preview-owned-encoder-preload.cjs",
                    ),
                    outputPath,
                    onFirstFrame: () =>
                      run(
                        DateTime.now.pipe(
                          Effect.flatMap((time) =>
                            request("event", {
                              ...privateIdentity(input),
                              event: "first_frame",
                              clientMonotonicMs: Math.floor(performance.now()),
                              observedAt: DateTime.formatIso(time),
                            }),
                          ),
                          Effect.asVoid,
                        ),
                      ),
                  }),
                catch: () => fail("encoder_unavailable"),
              });
              value = {
                intent: input,
                target,
                encoder,
                status,
                invalidation: null,
                cleanup,
                lastFrame: 0,
                loaded,
              };
              active = value;
              yield* manager
                .startOwnedCaptureFrames(input.tabID)
                .pipe(Effect.mapError(() => fail("owned_capture_busy")));
              const current = yield* manager
                .ownedCaptureTarget(input.tabID)
                .pipe(Effect.mapError(() => fail("target_changed")));
              if (
                current.documentID !== target.documentID ||
                current.frameID !== target.frameID ||
                current.targetID !== target.targetID ||
                current.url !== target.url ||
                current.webContentsID !== target.webContentsID
              )
                invalidate("Browser target changed before first frame");
              return status;
            } finally {
              if (!value) cleanup();
            }
          } finally {
            if (!active || active.intent.captureKey !== input.captureKey)
              yield* Effect.promise(() => loaded.restore());
          }
        }).pipe(
          Effect.mapError((cause) => (isCaptureError(cause) ? cause : fail("start_failed"))),
          Effect.onError(() =>
            Effect.gen(function* () {
              const value = active;
              if (
                value &&
                value.intent.captureKey === input.captureKey &&
                value.intent.token === input.token &&
                value.target.tabID === input.tabID
              ) {
                active = null;
                value.cleanup();
                yield* Effect.promise(() => value.loaded.restore());
                yield* manager.stopOwnedCaptureFrames(value.target.tabID).pipe(Effect.ignore);
                yield* Effect.promise(() => value.encoder.destroy());
              }
              if (began)
                yield* request("event", {
                  ...privateIdentity(input),
                  event: "cancel",
                  clientMonotonicMs: Math.floor(performance.now()),
                  observedAt: DateTime.formatIso(yield* DateTime.now),
                }).pipe(Effect.ignore);
            }),
          ),
        ),
      );
    };
    const stop: OwnedPreviewCapture["Service"]["stop"] = (captureKey) =>
      mutex.withPermit(
        Effect.gen(function* () {
          const value = active;
          if (!value || value.intent.captureKey !== captureKey)
            return yield* fail("capture_not_active");
          yield* manager.stopOwnedCaptureFrames(value.target.tabID).pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                value.invalidation ??= "Browser capture could not stop cleanly";
              }),
            ),
          );
          const targetResult = yield* Effect.result(manager.ownedCaptureTarget(value.target.tabID));
          const target = targetResult._tag === "Success" ? targetResult.success : value.target;
          if (targetResult._tag !== "Success")
            value.invalidation ??= "Browser target unavailable at capture end";
          value.invalidation ??= value.loaded.invalidation();
          const video = yield* Effect.tryPromise({
            try: () => value.encoder.finish(),
            catch: () => fail("encoder_finish_failed"),
          }).pipe(
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () => Effect.fail(fail("encoder_finish_timeout")),
            }),
          );
          yield* request("event", {
            ...privateIdentity(value.intent),
            event: "stop",
            observedAt: DateTime.formatIso(yield* DateTime.now),
            clientMonotonicMs: Math.floor(performance.now()),
          });
          const file = yield* Effect.tryPromise({
            try: () => NodeFSP.open(video.path, "r"),
            catch: () => fail("recorded_bytes_unavailable"),
          });
          try {
            for (let offset = 0; offset < video.size; offset += 262144) {
              const buffer = Buffer.alloc(Math.min(262144, video.size - offset));
              const read = yield* Effect.tryPromise({
                try: () => file.read(buffer, 0, buffer.length, offset),
                catch: () => fail("recorded_bytes_unavailable"),
              });
              if (read.bytesRead !== buffer.length) return yield* fail("recorded_bytes_truncated");
              yield* request("chunk", {
                ...privateIdentity(value.intent),
                offset,
                totalBytes: video.size,
                mimeType: video.mimeType,
                data: buffer.toString("base64"),
              });
            }
          } finally {
            yield* Effect.promise(() => file.close());
          }
          return yield* request("finish", {
            ...privateIdentity(value.intent),
            target,
            sourceVideoSHA256: video.sha256,
            sourceVideoSizeBytes: video.size,
            frameCount: video.frameCount,
            uninterrupted: !value.invalidation,
            invalidationReason: value.invalidation,
          });
        }).pipe(
          Effect.mapError((cause) => (isCaptureError(cause) ? cause : fail("stop_failed"))),
          Effect.ensuring(
            Effect.promise(async () => {
              const value = active;
              if (value?.intent.captureKey !== captureKey) return;
              active = null;
              if (value) {
                value.cleanup();
                await value.loaded.restore();
                await value.encoder.destroy();
              }
            }),
          ),
        ),
      );
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const value = active;
        active = null;
        if (value) {
          value.cleanup();
          yield* Effect.promise(() => value.loaded.restore());
          yield* manager.stopOwnedCaptureFrames(value.target.tabID).pipe(Effect.ignore);
          yield* Effect.promise(() => value.encoder.destroy());
        }
      }),
    );
    return OwnedPreviewCapture.of({ start, stop });
  }),
);
