import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@cinderdeck/shared/nodeSqliteClient";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  MessageId,
  ThreadId,
} from "@cinderdeck/contracts";
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
    "refuses active steering after generation or physical binding changes while allowing Stop and cleanup",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("steering-thread");
        const sessionId = ProviderSessionId.make("steering-session");
        const now = yield* DateTime.now;
        let generation = 7;
        let physicalId = "original-checkout";
        let steered = 0;
        let stopped = 0;
        const context = { cwd: "/fixture/checkout", physicalId };
        const upstream = Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          get: () =>
            Effect.succeed({
              instanceId,
              driver,
              getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
              planSelectionTransition: () =>
                Effect.succeed({ type: "apply_on_next_turn" as const }),
              openSession: () =>
                Effect.succeed({
                  instanceId,
                  driver,
                  providerSessionId: sessionId,
                  providerSession: {
                    id: sessionId,
                    driver,
                    providerInstanceId: instanceId,
                    status: "ready" as const,
                    cwd: context.cwd,
                    model: "fixture",
                    capabilities: CodexProviderCapabilitiesV2,
                    createdAt: now,
                    updatedAt: now,
                    lastError: null,
                  },
                  events: Stream.empty,
                  ensureThread: () => Effect.die("unused"),
                  resumeThread: () => Effect.die("unused"),
                  forkThread: () => Effect.die("unused"),
                  readThreadSnapshot: () => Effect.die("unused"),
                  rollbackThread: () => Effect.die("unused"),
                  startTurn: () => Effect.void,
                  steerTurn: () =>
                    Effect.sync(() => {
                      steered++;
                    }),
                  interruptTurn: () =>
                    Effect.sync(() => {
                      stopped++;
                    }),
                  respondToRuntimeRequest: () => Effect.void,
                }),
            }),
        });
        const guarded = Layer.mock(ManagedCheckoutGuard.ManagedCheckoutGuard)({
          resolve: () =>
            Effect.suspend(() =>
              generation !== 7
                ? Effect.fail(
                    new ManagedCheckoutGuard.ManagedCheckoutError({
                      threadId,
                      reason: "stale_binding",
                    }),
                  )
                : Effect.succeed({ ...context, physicalId }),
            ),
        });
        const layer = ManagedProviderAdapters.layer.pipe(
          Layer.provide(upstream),
          Layer.provide(guarded),
        );
        yield* Effect.gen(function* () {
          const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
          const adapter = yield* registry.get(instanceId);
          const scope = yield* Scope.make();
          const runtime = yield* adapter
            .openSession({
              threadId,
              providerSessionId: sessionId,
              modelSelection,
              runtimePolicy: policy(context.cwd),
            })
            .pipe(Effect.provideService(Scope.Scope, scope));
          const providerThread = {
            id: ProviderThreadId.make("steering-provider-thread"),
            driver,
            providerInstanceId: instanceId,
            providerSessionId: sessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "active" as const,
            pendingBackgroundTasks: [],
            contextUsage: null,
            nativeMetadata: null,
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          };
          const request = {
            threadId,
            runId: RunId.make("run"),
            providerThread,
            providerTurnId: ProviderTurnId.make("turn"),
            message: {
              messageId: MessageId.make("message"),
              text: "Please check again.",
              attachments: [],
              createdBy: "user" as const,
              creationSource: "web" as const,
            },
          };
          yield* runtime.steerTurn(request);
          assert.equal(steered, 1);
          generation = 8;
          assert.equal(
            (yield* runtime.steerTurn(request).pipe(Effect.flip))._tag,
            "ProviderAdapterProtocolError",
          );
          generation = 7;
          physicalId = "replacement-checkout";
          assert.equal(
            (yield* runtime.steerTurn(request).pipe(Effect.flip))._tag,
            "ProviderAdapterProtocolError",
          );
          assert.equal(steered, 1);
          yield* runtime.interruptTurn({ providerThread, providerTurnId: request.providerTurnId });
          assert.equal(stopped, 1);
          yield* Scope.close(scope, Exit.void);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })), Effect.scoped),
  );

  it.effect("uses the canonical Git root and starts concurrent agents in the same checkout", () =>
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
      let ensureCalls = 0;
      const providerLayer = Layer.effect(
        ProviderAdapterRegistry.ProviderAdapterRegistryV2,
        Effect.gen(function* () {
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
      const layer = ManagedProviderAdapters.layer.pipe(
        Layer.provide(providerLayer),
        Layer.provide(guardLayer),
      );
      yield* Effect.gen(function* () {
        const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
        const adapter = yield* registry.get(instanceId);
        const firstScope = yield* Scope.make();
        const secondScope = yield* Scope.make();
        const first = yield* adapter
          .openSession({
            threadId: ThreadId.make("first"),
            providerSessionId: ProviderSessionId.make("first-process"),
            modelSelection,
            runtimePolicy: policy(alias),
          })
          .pipe(Effect.provideService(Scope.Scope, firstScope));
        yield* adapter
          .openSession({
            threadId: ThreadId.make("second"),
            providerSessionId: ProviderSessionId.make("second-process"),
            modelSelection,
            runtimePolicy: policy(checkout),
          })
          .pipe(Effect.provideService(Scope.Scope, secondScope));
        assert.deepEqual(opened, [canonicalCheckout, canonicalCheckout]);
        const rejected = yield* first
          .ensureThread({
            threadId: ThreadId.make("first"),
            modelSelection,
            runtimePolicy: policy(root),
          })
          .pipe(Effect.flip);
        assert.equal(rejected._tag, "ProviderAdapterProtocolError");
        yield* Scope.close(firstScope, Exit.void);
        assert.deepEqual(closed, ["first-process"]);
        yield* Scope.close(secondScope, Exit.void);
        assert.deepEqual(closed, ["first-process", "second-process"]);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );
});
