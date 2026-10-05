import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import {
  collectLocalDiagnostics,
  diagnosticConfiguration,
  publicProviderVersion,
} from "./LocalDiagnostics.ts";
const encodeReport = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
describe("Local Deckhand diagnostics", () => {
  it.effect(
    "reports store presence without opening malformed databases or exposing stored secrets, logs, paths or environment values",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "deckhand-private-diagnostics-" });
        const store = path.join(root, "userdata");
        yield* fs.makeDirectory(path.join(store, "logs"), { recursive: true });
        const secret = "private-content-must-never-be-exported";
        yield* fs.writeFileString(path.join(store, "statev2.sqlite"), secret);
        yield* fs.writeFileString(path.join(store, "settings.json"), secret);
        yield* fs.writeFileString(path.join(store, "logs", "private.log"), secret);
        const report = yield* collectLocalDiagnostics({
          baseDir: root,
          providerVersions: false,
          env: {
            DECKHAND_HOME: root,
            DECKHAND_PROFILE_ROOT: root,
            T3CODE_HOME: secret,
            DECKHAND_OTLP_TRACES_URL: secret,
            DECKHAND_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
            OPENAI_API_KEY: secret,
          },
        });
        const json = yield* encodeReport(report);
        assert.notInclude(json, secret);
        assert.notInclude(json, root);
        assert.deepEqual(
          report.storage.find((item) => item.name === "statev2.sqlite"),
          { name: "statev2.sqlite", state: "present" },
        );
        assert.deepEqual(report.providers, []);
        assert.equal(report.configuration.updateFeed, "upstream_refused");
        assert.equal(report.integration.state, "not_contacted");
        assert.equal(yield* fs.readFileString(path.join(store, "statev2.sqlite")), secret);
        assert.isFalse(yield* fs.exists(path.join(store, "client-settings.json")));
      }).pipe(
        Effect.scoped,
        Effect.provide(NodeServices.layer),
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(HostProcessArchitecture, "arm64"),
      ),
  );
  it("exports only bounded version tokens and truthfully reports unset configuration", () => {
    assert.equal(publicProviderVersion("codex-cli 0.130.0\nprivate token-value"), "0.130.0");
    assert.equal(publicProviderVersion("Claude Code 2.1.91 (local)"), "2.1.91");
    assert.equal(publicProviderVersion("private output without a version"), null);
    assert.equal(publicProviderVersion("x".repeat(4096) + "1.2.3"), null);
    assert.deepEqual(diagnosticConfiguration({ OPENAI_API_KEY: "private" }), {
      explicitDataRoot: false,
      desktopProfileOverride: false,
      upstreamDataRootIgnored: false,
      cinderdeckSocketOverride: false,
      analyticsConfigured: false,
      traceExporterConfigured: false,
      updateFeed: "unconfigured",
    });
  });
});
