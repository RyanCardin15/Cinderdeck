import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopConfig from "./DesktopConfig.ts";

const defaultInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "darwin",
  processArch: "arm64",
  appVersion: "0.0.22",
  appPath: "/Applications/Cinderdeck.app/Contents/Resources/app.asar",
  isPackaged: false,
  resourcesPath: "/Applications/Cinderdeck.app/Contents/Resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeEnvironmentLayer = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.layer({
    ...defaultInput,
    ...overrides,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest(env)),
    ),
  );

const makeEnvironment = (
  overrides: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput> = {},
  env: Record<string, string | undefined> = {},
) =>
  DesktopEnvironment.DesktopEnvironment.pipe(Effect.provide(makeEnvironmentLayer(overrides, env)));

describe("DesktopEnvironment", () => {
  it.effect("ignores ambient development URLs in the packaged Mac application", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        { isPackaged: true },
        { VITE_DEV_SERVER_URL: "http://localhost:5733", DECKHAND_RENDERER_TOKEN: "ambient-token" },
      );
      assert.equal(environment.isDevelopment, false);
      assert.equal(Option.isNone(environment.devServerUrl), true);
      assert.equal(
        environment.clientAssetsDir,
        "/Applications/Cinderdeck.app/Contents/Resources/app.asar/apps/server/dist/client",
      );
    }),
  );
  it("keeps packaged preview and PR titles distinct from nightly and development", () => {
    for (const appVersion of ["0.1.0-preview.20261003.3", "0.1.0-pr.42.1"]) {
      assert.deepEqual(
        DesktopEnvironment.resolveDesktopAppBranding({ isDevelopment: false, appVersion }),
        {
          baseName: "Cinderdeck",
          stageLabel: "Preview",
          displayName: "Cinderdeck (Preview)",
        },
      );
    }
    assert.equal(
      DesktopEnvironment.resolveDesktopAppBranding({
        isDevelopment: false,
        appVersion: "0.1.0-nightly.20261003.3",
      }).stageLabel,
      "Nightly",
    );
    assert.equal(
      DesktopEnvironment.resolveDesktopAppBranding({
        isDevelopment: true,
        appVersion: "0.1.0-preview.20261003.3",
      }).stageLabel,
      "Dev",
    );
  });
  it.effect("derives state paths and development identity inside Effect", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          DECKHAND_HOME: " /tmp/cinderdeck ",
          DECKHAND_COMMIT_HASH: " 0123456789abcdef ",
          DECKHAND_PORT: "4949",
          VITE_DEV_SERVER_URL: "http://localhost:5173",
          DECKHAND_OTLP_TRACES_URL: " http://127.0.0.1:4318/v1/traces ",
          DECKHAND_OTLP_METRICS_URL: " http://127.0.0.1:4318/v1/metrics ",
          DECKHAND_OTLP_LOGS_URL: " http://127.0.0.1:4318/v1/logs ",
          DECKHAND_OTLP_EXPORT_INTERVAL_MS: "2500",
          DECKHAND_OTLP_HEADERS: "authorization=Basic%20abc%3D%3D,x-tenant=cinderdeck",
          DECKHAND_OTLP_PROTOCOL: "http/protobuf",
        },
      );

      assert.equal(environment.isDevelopment, true);
      assert.equal(environment.appDataDirectory, "/Users/alice/Library/Application Support");
      assert.equal(environment.baseDir, "/tmp/cinderdeck");
      assert.equal(environment.stateDir, "/tmp/cinderdeck/userdata");
      assert.equal(environment.desktopSettingsPath, "/tmp/cinderdeck/userdata/desktop-settings.json");
      assert.equal(environment.clientSettingsPath, "/tmp/cinderdeck/userdata/client-settings.json");
      assert.equal(
        environment.savedEnvironmentRegistryPath,
        "/tmp/cinderdeck/userdata/saved-environments.json",
      );
      assert.equal(environment.serverSettingsPath, "/tmp/cinderdeck/userdata/settings.json");
      assert.equal(environment.logDir, "/tmp/cinderdeck/userdata/logs");
      assert.equal(environment.browserArtifactsDir, "/tmp/cinderdeck/userdata/browser-artifacts");
      assert.equal(environment.rootDir, "/repo");
      assert.equal(environment.appRoot, "/repo");
      assert.equal(environment.backendEntryPath, "/repo/apps/server/dist/bin.mjs");
      assert.equal(environment.backendCwd, "/repo");
      assert.deepEqual(
        Option.map(environment.devServerUrl, (url) => url.href),
        Option.some("http://localhost:5173/"),
      );
      assert.deepEqual(environment.configuredBackendPort, Option.some(4949));
      assert.deepEqual(environment.commitHashOverride, Option.some("0123456789abcdef"));
      assert.deepEqual(environment.otlpTracesUrl, Option.some("http://127.0.0.1:4318/v1/traces"));
      assert.deepEqual(environment.otlpMetricsUrl, Option.some("http://127.0.0.1:4318/v1/metrics"));
      assert.deepEqual(environment.otlpLogsUrl, Option.some("http://127.0.0.1:4318/v1/logs"));
      assert.equal(environment.otlpExportIntervalMs, 2500);
      assert.deepEqual(
        environment.otlpHeaders,
        Option.some({
          authorization: "Basic abc==",
          "x-tenant": "cinderdeck",
        }),
      );
      assert.equal(environment.otlpProtocol, "http/protobuf");
    }),
  );

  it.effect("stores production state under userdata in an explicit home", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment(
        {},
        {
          DECKHAND_HOME: "/tmp/cinderdeck",
        },
      );

      assert.equal(environment.isDevelopment, false);
      assert.equal(environment.stateDir, "/tmp/cinderdeck/userdata");
      assert.equal(environment.logDir, "/tmp/cinderdeck/userdata/logs");
      assert.equal(environment.browserArtifactsDir, "/tmp/cinderdeck/userdata/browser-artifacts");
      assert.equal(environment.serverSettingsPath, "/tmp/cinderdeck/userdata/settings.json");
      assert.equal(environment.otlpProtocol, "http/json");
    }),
  );

  it.effect("serves the packaged backend from the app bundle", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment({ isPackaged: true });

      assert.equal(environment.appRoot, defaultInput.appPath);
      assert.equal(
        environment.backendEntryPath,
        `${defaultInput.appPath}/apps/server/dist/bin.mjs`,
      );
      assert.equal(environment.clientAssetsDir, `${defaultInput.appPath}/apps/server/dist/client`);
      assert.equal(environment.backendCwd, "/Users/alice");
    }),
  );

  it.effect("keeps implicit development state separate from production state", () =>
    Effect.gen(function* () {
      const development = yield* makeEnvironment(
        {},
        { VITE_DEV_SERVER_URL: "http://localhost:5173" },
      );
      const production = yield* makeEnvironment();

      assert.equal(development.stateDir, "/Users/alice/.deckhand/dev");
      assert.equal(production.stateDir, "/Users/alice/.deckhand/userdata");
    }),
  );

  it.effect("resolves picker defaults without nullish sentinels", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment();

      assert.deepEqual(environment.resolvePickFolderDefaultPath(null), Option.none());
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: " " }),
        Option.none(),
      );
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: "~" }),
        Option.some("/Users/alice"),
      );
      assert.deepEqual(
        environment.resolvePickFolderDefaultPath({ initialPath: "~/project" }),
        Option.some("/Users/alice/project"),
      );
    }),
  );
});
