import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationV2ThreadShell,
} from "@cinderdeck/contracts";
import type { ThreadContextView } from "@cinderdeck/contracts/deckhand/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Access from "./DeckhandMcpAccess.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as ThreadContext from "../deckhand/ThreadContext.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("computer"),
  threadId: ThreadId.make("caller"),
  providerSessionId: "provider-session",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const caller = {
  id: scope.threadId,
  deletedAt: null,
  archivedAt: null,
  activeRunId: "run",
  providerInstanceId: scope.providerInstanceId,
} as OrchestrationV2ThreadShell;
const view = {
  workspace: { environmentId: "native-installation", ownerId: "workspace" },
  checkout: { laneId: "lane", nativeGeneration: 7 },
  native: { available: true },
  nativeConnection: "connected",
} as ThreadContextView;
const harness = (
  thread: OrchestrationV2ThreadShell = caller,
  context: ThreadContextView | null = view,
) =>
  Access.layer.pipe(
    Layer.provide(
      Layer.mock(Threads.ThreadManagementService)({ getThreadShell: () => Effect.succeed(thread) }),
    ),
    Layer.provide(
      Layer.mock(ThreadContext.ThreadContext)({
        subscribe: (input) => {
          expect(input.threadId).toBe(scope.threadId);
          return Stream.make(context);
        },
      }),
    ),
  );
it.effect("binds reads to the caller lane and uses provider actor ownership", () =>
  Effect.gen(function* () {
    const access = yield* Access.DeckhandMcpAccess;
    expect(yield* access.resolve()).toMatchObject({
      actor: "mcp:provider-session",
      input: { installationID: "native-installation", workspaceID: "lane", generation: 7 },
    });
  }).pipe(Effect.provide(harness()), Effect.provideService(Invocation.McpInvocationContext, scope)),
);
it.effect("refuses unavailable context instead of selecting another workspace", () =>
  Effect.gen(function* () {
    const access = yield* Access.DeckhandMcpAccess;
    const result = yield* Effect.result(access.resolve());
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("invalid_request");
  }).pipe(
    Effect.provide(harness(caller, null)),
    Effect.provideService(Invocation.McpInvocationContext, scope),
  ),
);
it.effect("requires a live owning provider before mutating", () =>
  Effect.gen(function* () {
    const access = yield* Access.DeckhandMcpAccess;
    const result = yield* Effect.result(access.resolve(true));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("parent_not_active");
  }).pipe(
    Effect.provide(harness({ ...caller, activeRunId: null })),
    Effect.provideService(Invocation.McpInvocationContext, scope),
  ),
);
it.effect("checks capability before accessing the saved context", () =>
  Effect.gen(function* () {
    const access = yield* Access.DeckhandMcpAccess;
    const result = yield* Effect.result(access.resolve());
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.code).toBe("capability_denied");
  }).pipe(
    Effect.provide(harness()),
    Effect.provideService(Invocation.McpInvocationContext, {
      ...scope,
      capabilities: new Set<Invocation.McpCapability>(),
    }),
  ),
);
