// @effect-diagnostics nodeBuiltinImport:off - Tests use a real isolated discovery directory.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import * as IntegrationDiscovery from "./IntegrationDiscovery.ts";
const discover = (statePath: string, socketPath?: string) =>
  Effect.gen(function* () {
    const discovery = yield* IntegrationDiscovery.IntegrationDiscovery;
    return yield* discovery.locate;
  }).pipe(
    Effect.provide(
      IntegrationDiscovery.layer.pipe(
        Layer.provide(
          Layer.succeed(IntegrationDiscovery.DiscoveryConfig, {
            channel: "development",
            statePath,
            ...(socketPath ? { socketPath } : {}),
          }),
        ),
        Layer.provide(
          Layer.succeed(IntegrationDiscovery.HostIdentity, {
            get: Effect.succeed("execution-host"),
          }),
        ),
      ),
    ),
  );
describe("Cinderdeck discovery", () => {
  it.effect(
    "follows the native discovery socket including a short-path fallback and checks private ownership",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "dh-discovery-" });
        const statePath = `${root}/state.json`;
        yield* fs.chmod(root, 0o700);
        yield* fs.writeFileString(
          statePath,
          '{"appRunning":true,"socket":"/tmp/cinderdeck-stacks-501.sock"}',
        );
        // The native file may be 0644 inside its private, user-owned directory.
        yield* fs.chmod(statePath, 0o644);
        assert.deepEqual(yield* discover(statePath), {
          socketPath: "/tmp/cinderdeck-stacks-501.sock",
          hostID: "execution-host",
          channel: "development",
        });
        yield* fs.chmod(root, 0o755);
        assert.equal((yield* discover(statePath).pipe(Effect.flip)).reason, "unauthorized_socket");
        // An explicit socket override does not guess or read an unrelated app's state.
        assert.equal(
          (yield* discover("/missing/state.json", "/tmp/isolated.sock")).socketPath,
          "/tmp/isolated.sock",
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("reports stopped and absent applications and rejects relative discovery sockets", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "dh-discovery-" });
      yield* fs.chmod(root, 0o700);
      const statePath = `${root}/state.json`;
      assert.equal((yield* discover(statePath).pipe(Effect.flip)).reason, "unavailable");
      yield* fs.writeFileString(statePath, '{"appRunning":false,"socket":"/tmp/native.sock"}');
      assert.equal((yield* discover(statePath).pipe(Effect.flip)).reason, "unavailable");
      yield* fs.writeFileString(statePath, '{"appRunning":true,"socket":"relative.sock"}');
      assert.equal((yield* discover(statePath).pipe(Effect.flip)).reason, "invalid_response");
      assert.equal(
        (yield* discover(statePath, "relative.sock").pipe(Effect.flip)).reason,
        "invalid_request",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "retries a transient OS identity failure and then caches the verified execution host",
    () => {
      let runs = 0;
      const runner = ProcessRunner.ProcessRunner.of({
        run: () =>
          Effect.sync(() => ({
            code: ChildProcessSpawner.ExitCode(++runs === 1 ? 1 : 0),
            stdout: runs === 1 ? "" : '"IOPlatformUUID" = "ABCDEF12-3456-4789-ABCD-0123456789AB"',
            stderr: "",
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          })),
      });
      return Effect.gen(function* () {
        const identity = yield* IntegrationDiscovery.HostIdentity;
        assert.equal((yield* identity.get.pipe(Effect.flip)).code, "host_identity_unavailable");
        assert.equal(yield* identity.get, "abcdef12-3456-4789-abcd-0123456789ab");
        assert.equal(yield* identity.get, "abcdef12-3456-4789-abcd-0123456789ab");
        assert.equal(runs, 2);
      }).pipe(
        Effect.provide(
          IntegrationDiscovery.hostLayer.pipe(
            Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
          ),
        ),
        Effect.provideService(HostProcessPlatform, "darwin"),
      );
    },
  );
});
