import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderAdapter from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";
import * as IntegrationHub from "./IntegrationHub.ts";
import * as ManagedCheckoutGuard from "./ManagedCheckoutGuard.ts";
import * as ManagedProviderAdapters from "./ManagedProviderAdapters.ts";
import * as Relationships from "./Relationships.ts";
import * as NativeWriterReservations from "./NativeWriterReservations.ts";
import * as WriterReservations from "./WriterReservations.ts";

const instanceId = ProviderInstanceId.make("codex-fixture");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "fixture" };
const policy = (cwd: string) => ({
  cwd,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
});
const baseLayer = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  ProcessRunner.layer,
  // Standalone tests never connect to a native application. All native methods
  // remain unavailable rather than replacing the checkout/reservation logic.
  Layer.mock(IntegrationHub.IntegrationHub)({}),
).pipe(Layer.provideMerge(NodeServices.layer));
const guardLayer = ManagedCheckoutGuard.layer.pipe(
  Layer.provide(Relationships.layer),
  Layer.provide(CheckoutIdentity.layer),
);
describe("managed provider process admission", () => {
  it.effect(
    "uses the canonical Git root, queues a path alias before spawn, and releases after process close",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const runner = yield* ProcessRunner.ProcessRunner;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "dh-managed-" });
        const checkout = `${root}/checkout`;
        const alias = `${root}/alias`;
        const other = `${root}/other`;
        yield* fs.makeDirectory(checkout);
        const initialized = yield* runner.run({
          command: "git",
          args: ["-C", checkout, "init", "-b", "main"],
        });
        assert.equal(initialized.code, 0);
        yield* fs.makeDirectory(other);
        assert.equal(
          (yield* runner.run({ command: "git", args: ["-C", other, "init", "-b", "main"] })).code,
          0,
        );
        yield* fs.symlink(checkout, alias);
        const guard = yield* ManagedCheckoutGuard.ManagedCheckoutGuard.pipe(
          Effect.provide(guardLayer),
        );
        yield* fs.makeDirectory(`${root}/non-git`);
        assert.isNull(yield* guard.resolve(ThreadId.make("ordinary"), `${root}/non-git`));
        assert.equal(
          (yield* guard.resolve(ThreadId.make("missing"), `${root}/missing`).pipe(Effect.flip))
            .reason,
          "unavailable",
        );
        const canonicalCheckout = yield* fs.realPath(checkout);
        const opened: string[] = [];
        const closed: string[] = [];
        const nativeReleased: string[] = [];
        let ownershipAtClose = false;
        let ensureCalls = 0;
        const providerLayer = Layer.effect(
          ProviderAdapterRegistry.ProviderAdapterRegistryV2,
          Effect.gen(function* () {
            const ownership = yield* WriterReservations.WriterReservations;
            const adapter: ProviderAdapter.ProviderAdapterV2Shape = {
              instanceId,
              driver,
              getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
              planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
              openSession: (input) =>
                Effect.gen(function* () {
                  opened.push(input.runtimePolicy.cwd ?? "missing");
                  yield* Effect.addFinalizer(() =>
                    Effect.gen(function* () {
                      ownershipAtClose = (yield* ownership.inspect).some(
                        (row) => row.ownerId === input.threadId && row.state === "held",
                      );
                      closed.push(input.providerSessionId);
                      if (input.providerSessionId === "failed-process")
                        return yield* Effect.die("Provider failed to close");
                    }).pipe(Effect.orDie),
                  );
                  const now = yield* DateTime.now;
                  const unused = Effect.die(
                    "This external provider operation is not used in the admission test",
                  );
                  return {
                    instanceId,
                    driver,
                    providerSessionId: input.providerSessionId,
                    providerSession: {
                      id: input.providerSessionId,
                      driver,
                      providerInstanceId: instanceId,
                      status: "ready",
                      cwd: input.runtimePolicy.cwd ?? "missing",
                      model: "fixture",
                      capabilities: CodexProviderCapabilitiesV2,
                      createdAt: now,
                      updatedAt: now,
                      lastError: null,
                    },
                    events: Stream.empty,
                    ensureThread: (request) =>
                      Effect.sync(() => {
                        ensureCalls++;
                      }).pipe(
                        Effect.andThen(
                          new ProviderAdapter.ProviderAdapterEnsureThreadError({
                            driver,
                            threadId: request.threadId,
                          }),
                        ),
                      ),
                    resumeThread: () => unused,
                    forkThread: () => unused,
                    readThreadSnapshot: () => unused,
                    rollbackThread: () => unused,
                    startTurn: () => Effect.void,
                    steerTurn: () => Effect.void,
                    interruptTurn: () => Effect.void,
                    respondToRuntimeRequest: () => Effect.void,
                  } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
                }),
            };
            return { get: () => Effect.succeed(adapter), list: () => Effect.succeed([instanceId]) };
          }),
        );
        const sharedOwnership = WriterReservations.layer;
        const layer = ManagedProviderAdapters.layer.pipe(
          Layer.provide(providerLayer.pipe(Layer.provide(sharedOwnership))),
          Layer.provide(guardLayer),
          Layer.provide(
            Layer.succeed(NativeWriterReservations.NativeWriterReservations, {
              acquire: (ownerId) => Effect.succeed(ownerId),
              verify: () => Effect.void,
              release: (ownerId) =>
                Effect.sync(() => {
                  // This finalizer must inspect stop proof at close time, not registration.
                  assert.isTrue(closed.length > 0);
                  nativeReleased.push(ownerId);
                }),
            }),
          ),
          Layer.provideMerge(sharedOwnership),
        );
        yield* Effect.gen(function* () {
          const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
          const reservations = yield* WriterReservations.WriterReservations;
          const adapter = yield* registry.get(instanceId);
          const firstScope = yield* Scope.make();
          const first = yield* adapter
            .openSession({
              threadId: ThreadId.make("first"),
              providerSessionId: ProviderSessionId.make("first-process"),
              modelSelection,
              runtimePolicy: policy(alias),
            })
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          assert.deepEqual(opened, [canonicalCheckout]);
          const rejected = yield* first
            .ensureThread({
              threadId: ThreadId.make("first"),
              modelSelection,
              runtimePolicy: policy(root),
            })
            .pipe(Effect.flip);
          assert.equal(rejected._tag, "ProviderAdapterProtocolError");
          const nativeRejected = yield* first
            .ensureThread({
              threadId: ThreadId.make("other-thread"),
              modelSelection,
              runtimePolicy: policy(other),
            })
            .pipe(Effect.flip);
          assert.equal(nativeRejected._tag, "ProviderAdapterEnsureThreadError");
          assert.equal(ensureCalls, 1);
          assert.deepEqual(
            (yield* reservations.inspect).map((row) => row.ownerId),
            ["first", "other-thread"],
          );
          const sharedAlias = yield* first
            .ensureThread({
              threadId: ThreadId.make("alias-thread"),
              modelSelection,
              runtimePolicy: policy(alias),
            })
            .pipe(Effect.forkChild);
          yield* reservations.changes.pipe(
            Stream.filter((rows) =>
              rows.some((row) => row.ownerId === "alias-thread" && row.state === "queued"),
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          yield* Fiber.interrupt(sharedAlias);
          assert.equal(ensureCalls, 1);
          assert.deepEqual(
            (yield* reservations.inspect).map((row) => row.ownerId),
            ["first", "other-thread"],
          );
          const secondDone = yield* Deferred.make<void>();
          const second = yield* Effect.scoped(
            Effect.gen(function* () {
              yield* adapter.openSession({
                threadId: ThreadId.make("second"),
                providerSessionId: ProviderSessionId.make("second-process"),
                modelSelection,
                runtimePolicy: policy(checkout),
              });
              yield* Deferred.await(secondDone);
            }),
          ).pipe(Effect.forkChild);
          yield* reservations.changes.pipe(
            Stream.filter((rows) =>
              rows.some((row) => row.ownerId === "second" && row.state === "queued"),
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          assert.deepEqual(opened, [canonicalCheckout]);
          yield* Scope.close(firstScope, Exit.void);
          yield* reservations.changes.pipe(
            Stream.filter((rows) =>
              rows.some((row) => row.ownerId === "second" && row.state === "held"),
            ),
            Stream.take(1),
            Stream.runDrain,
          );
          yield* Deferred.succeed(secondDone, undefined);
          yield* Fiber.join(second);
          assert.deepEqual(opened, [canonicalCheckout, canonicalCheckout]);
          assert.deepEqual(closed, ["first-process", "second-process"]);
          assert.isTrue(ownershipAtClose);
          assert.deepEqual(yield* reservations.inspect, []);
          const failedScope = yield* Scope.make();
          yield* adapter
            .openSession({
              threadId: ThreadId.make("failed"),
              providerSessionId: ProviderSessionId.make("failed-process"),
              modelSelection,
              runtimePolicy: policy(checkout),
            })
            .pipe(Effect.provideService(Scope.Scope, failedScope));
          assert.equal(
            (yield* Scope.close(failedScope, Exit.void).pipe(Effect.exit))._tag,
            "Failure",
          );
          assert.deepEqual(
            (yield* reservations.inspect).map((row) => [row.ownerId, row.state]),
            [["failed", "uncertain"]],
          );
          assert.isTrue(nativeReleased.includes("first"));
          assert.isTrue(nativeReleased.includes("second"));
          assert.isFalse(nativeReleased.includes("failed"));
        }).pipe(Effect.provide(layer), Effect.scoped);
      }).pipe(Effect.provide(baseLayer)),
  );
});
