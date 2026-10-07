import { parsePersistedServerObservabilitySettings } from "@cinderdeck/shared/serverSettings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";

export class DesktopBackendObservabilitySettingsReadError extends Schema.TaggedError<DesktopBackendObservabilitySettingsReadError>()(
  "DesktopBackendObservabilitySettingsReadError",
  {
    settingsPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read persisted backend observability settings at ${this.settingsPath}.`;
  }
}

export class DesktopBackendConfiguration extends Context.Service<
  DesktopBackendConfiguration,
  {
    // Build the primary backend's start config. Reads the primary's
    // port/host/exposure from DesktopServerExposure. Can fail with
    // PlatformError because bootstrap token generation uses
    // crypto.randomBytes under the hood.
    readonly resolvePrimary: Effect.Effect<
      DesktopBackendManager.DesktopBackendStartConfig,
      PlatformError.PlatformError
    >;
    // The renderer-facing label for the primary instance.
    readonly resolvePrimaryLabel: Effect.Effect<string>;
  }
>()("@cinderdeck/desktop/backend/DesktopBackendConfiguration") {}

interface BackendObservabilitySettings {
  readonly otlpTracesUrl: Option.Option<string>;
  readonly otlpMetricsUrl: Option.Option<string>;
  readonly otlpLogsUrl: Option.Option<string>;
}

const emptyBackendObservabilitySettings: BackendObservabilitySettings = {
  otlpTracesUrl: Option.none(),
  otlpMetricsUrl: Option.none(),
  otlpLogsUrl: Option.none(),
};

const DESKTOP_BACKEND_ENV_NAMES = [
  // Launch-only native UI capability stays in Electron's trusted main process.
  "CINDERDECK_NATIVE_UI_TOKEN",
  "DECKHAND_PORT",
  "DECKHAND_MODE",
  "DECKHAND_NO_BROWSER",
  "DECKHAND_HOST",
  "DECKHAND_DESKTOP_WS_URL",
  "DECKHAND_DESKTOP_LAN_ACCESS",
  "DECKHAND_DESKTOP_LAN_HOST",
  "DECKHAND_DESKTOP_HTTPS_ENDPOINTS",
  "DECKHAND_TAILSCALE_SERVE",
  "DECKHAND_TAILSCALE_SERVE_PORT",
] as const;

const backendChildEnvPatch = (): Record<string, string | undefined> =>
  Object.fromEntries(DESKTOP_BACKEND_ENV_NAMES.map((name) => [name, undefined]));

const logBackendObservabilitySettingsReadFailure = (
  settingsPath: string,
  cause: PlatformError.PlatformError,
) => {
  const error = new DesktopBackendObservabilitySettingsReadError({ settingsPath, cause });
  return Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      component: "desktop-backend-configuration",
      error,
    }),
  );
};

const RESOURCE_MONITOR_BINARY_NAME = "t3-resource-monitor";

const resolveResourceMonitorPath = Effect.fn(
  "desktop.backendConfiguration.resolveResourceMonitorPath",
)(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const binaryName = RESOURCE_MONITOR_BINARY_NAME;
  const candidates = environment.isDevelopment
    ? [
        environment.path.join(
          environment.rootDir,
          "native/resource-monitor/target/release",
          binaryName,
        ),
        environment.path.join(
          environment.rootDir,
          "native/resource-monitor/target/debug",
          binaryName,
        ),
      ]
    : environment.isPackaged
      ? [environment.path.join(environment.resourcesPath, "resource-monitor", binaryName)]
      : environment.resolveResourcePathCandidates(
          environment.path.join("resource-monitor", binaryName),
        );

  for (const candidate of candidates) {
    if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
      return Option.some(candidate);
    }
  }

  return Option.none<string>();
});

const readPersistedBackendObservabilitySettings = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const raw = yield* fileSystem.readFileString(environment.serverSettingsPath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (cause) =>
        cause.reason._tag === "NotFound"
          ? Effect.succeedNone
          : logBackendObservabilitySettingsReadFailure(environment.serverSettingsPath, cause).pipe(
              Effect.as(Option.none()),
            ),
    }),
  );
  if (Option.isNone(raw)) {
    return emptyBackendObservabilitySettings;
  }

  const parsed = parsePersistedServerObservabilitySettings(raw.value);
  return {
    otlpTracesUrl: Option.fromNullishOr(parsed.otlpTracesUrl),
    otlpMetricsUrl: Option.fromNullishOr(parsed.otlpMetricsUrl),
    otlpLogsUrl: Option.fromNullishOr(parsed.otlpLogsUrl),
  };
});

// The bootstrap carries the OTLP endpoints to the backend. Env beats the
// persisted settings file, matching the precedence resolveServerConfig and
// DesktopObservability apply.
const readBackendObservabilitySettings = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const persisted = yield* readPersistedBackendObservabilitySettings;
  return {
    otlpTracesUrl: Option.orElse(environment.otlpTracesUrl, () => persisted.otlpTracesUrl),
    otlpMetricsUrl: Option.orElse(environment.otlpMetricsUrl, () => persisted.otlpMetricsUrl),
    otlpLogsUrl: Option.orElse(environment.otlpLogsUrl, () => persisted.otlpLogsUrl),
  } satisfies BackendObservabilitySettings;
});

interface SharedBootstrapInput {
  readonly bootstrapToken: string;
  readonly captureToken?: string;
  readonly observabilitySettings: BackendObservabilitySettings;
}

const buildObservabilityFragment = (observabilitySettings: BackendObservabilitySettings) => ({
  ...Option.match(observabilitySettings.otlpTracesUrl, {
    onNone: () => ({}),
    onSome: (otlpTracesUrl) => ({ otlpTracesUrl }),
  }),
  ...Option.match(observabilitySettings.otlpMetricsUrl, {
    onNone: () => ({}),
    onSome: (otlpMetricsUrl) => ({ otlpMetricsUrl }),
  }),
  ...Option.match(observabilitySettings.otlpLogsUrl, {
    onNone: () => ({}),
    onSome: (otlpLogsUrl) => ({ otlpLogsUrl }),
  }),
});

const resolvePrimaryStartConfig = Effect.fn("desktop.backendConfiguration.resolvePrimary")(
  function* (
    input: SharedBootstrapInput & {
      readonly resourceMonitorPath: Option.Option<string>;
    },
  ): Effect.fn.Return<
    DesktopBackendManager.DesktopBackendStartConfig,
    never,
    DesktopEnvironment.DesktopEnvironment | DesktopServerExposure.DesktopServerExposure
  > {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const backendExposure = yield* serverExposure.backendConfig;

    const bootstrap = {
      mode: "desktop" as const,
      noBrowser: true,
      port: backendExposure.port,
      t3Home: environment.baseDir,
      host: backendExposure.bindHost,
      desktopBootstrapToken: input.bootstrapToken,
      ...(input.captureToken ? { desktopCaptureToken: input.captureToken } : {}),
      tailscaleServeEnabled: backendExposure.tailscaleServeEnabled,
      tailscaleServePort: backendExposure.tailscaleServePort,
      desktopTelemetryFd: 4,
      desktopTelemetryControlFd: 5,
      ...Option.match(input.resourceMonitorPath, {
        onNone: () => ({}),
        onSome: (resourceMonitorPath) => ({ resourceMonitorPath }),
      }),
      ...buildObservabilityFragment(input.observabilitySettings),
    };

    return {
      executablePath: process.execPath,
      // Packaged builds only, so a dev instance never shares the cache with the
      // prod app it is often run from. `--require` rather than NODE_COMPILE_CACHE,
      // so the setting does not leak into the provider and terminal processes
      // the backend starts.
      args: [
        ...(environment.isPackaged ? ["--require", environment.compileCachePath] : []),
        environment.backendEntryPath,
        "--bootstrap-fd",
        "3",
      ],
      entryPath: environment.backendEntryPath,
      cwd: environment.backendCwd,
      env: {
        ...backendChildEnvPatch(),
        ELECTRON_RUN_AS_NODE: "1",
      },
      // Primary wants process.env (PATH, dev-runner's DECKHAND_HOME, etc.).
      extendEnv: true,
      bootstrap,
      httpBaseUrl: backendExposure.httpBaseUrl,
      captureOutput: true,
    } satisfies DesktopBackendManager.DesktopBackendStartConfig;
  },
);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  const crypto = yield* Crypto.Crypto;
  // SynchronizedRef (not a plain Ref) so the read-generate-write is atomic.
  // crypto.randomBytes is a yield point; modifyEffect serializes the whole
  // get-or-create so concurrent restarts reuse one token instead of racing
  // to generate distinct ones.
  const tokenRef = yield* SynchronizedRef.make(Option.none<string>());
  const getOrCreateBootstrapToken = SynchronizedRef.modifyEffect(tokenRef, (current) =>
    Option.match(current, {
      onSome: (token) => Effect.succeed([token, current] as const),
      onNone: () =>
        crypto.randomBytes(24).pipe(
          Effect.map((bytes) => {
            const token = Encoding.encodeHex(bytes);
            return [token, Option.some(token)] as const;
          }),
        ),
    }),
  );

  // Restarts reuse the same bootstrap token, which the renderer holds.
  // Observability settings get re-read each resolve so a hot-swap of the
  // server-settings file is picked up on the next restart cycle without
  // having to bounce the desktop process.
  const captureToken = Encoding.encodeHex(yield* crypto.randomBytes(32));
  const sharedInputs = Effect.gen(function* () {
    const bootstrapToken = yield* getOrCreateBootstrapToken;
    const observabilitySettings = yield* readBackendObservabilitySettings.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    return { bootstrapToken, captureToken, observabilitySettings } satisfies SharedBootstrapInput;
  });

  const buildPrimaryConfig = Effect.gen(function* () {
    const shared = yield* sharedInputs;
    const resourceMonitorPath = yield* resolveResourceMonitorPath().pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );
    return yield* resolvePrimaryStartConfig({ ...shared, resourceMonitorPath }).pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(DesktopServerExposure.DesktopServerExposure, serverExposure),
    );
  });

  return DesktopBackendConfiguration.of({
    resolvePrimary: buildPrimaryConfig.pipe(
      Effect.withSpan("desktop.backendConfiguration.resolvePrimary"),
    ),
    resolvePrimaryLabel: Effect.succeed("Local environment"),
  });
});

export const layer = Layer.effect(DesktopBackendConfiguration, make);
