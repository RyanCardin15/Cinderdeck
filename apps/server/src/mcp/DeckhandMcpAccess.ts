import { OrchestratorMcpFailure } from "@t3tools/contracts";
import type { RunContext } from "@t3tools/contracts/deckhand/runsRpc";
import type { ThreadContextView } from "@t3tools/contracts/deckhand/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ThreadContext from "../deckhand/ThreadContext.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "./McpInvocationContext.ts";
import { readCaller, readMutationCaller } from "./threadAccess.ts";

const isMcpFailure = Schema.is(OrchestratorMcpFailure);
export const deckhandFailure = (error: unknown) =>
  isMcpFailure(error)
    ? error
    : new OrchestratorMcpFailure({
        code: "orchestration_error",
        message:
          typeof error === "object" &&
          error !== null &&
          "reason" in error &&
          typeof error.reason === "string" &&
          /^[a-z_]{1,80}$/.test(error.reason)
            ? `Deckhand ${error.reason}.`
            : "The Deckhand operation could not be completed.",
      });
export class DeckhandMcpAccess extends Context.Service<
  DeckhandMcpAccess,
  {
    readonly resolve: (mutation?: boolean) => Effect.Effect<
      {
        readonly actor: string;
        readonly input: RunContext;
        readonly view: ThreadContextView;
      },
      OrchestratorMcpFailure,
      Invocation.McpInvocationContext
    >;
  }
>()("t3/mcp/DeckhandMcpAccess") {}
export const layer = Layer.effect(
  DeckhandMcpAccess,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const contexts = yield* ThreadContext.ThreadContext;
    return DeckhandMcpAccess.of({
      resolve: (mutation = false) =>
        Effect.gen(function* () {
          const { scope } = yield* mutation ? readMutationCaller() : readCaller();
          const first = yield* contexts
            .subscribe({ threadId: scope.threadId })
            .pipe(Stream.runHead, Effect.timeout("15 seconds"), Effect.mapError(deckhandFailure));
          const view = Option.getOrNull(first);
          if (
            !view?.native ||
            view.nativeConnection !== "connected" ||
            !view.checkout.nativeGeneration
          )
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "This thread has no available managed Cinderdeck lane. Reconnect or bind a lane in Deckhand.",
            });
          return {
            actor: `mcp:${scope.providerSessionId}`,
            input: {
              installationID: view.workspace.environmentId,
              workspaceID: view.checkout.laneId ?? view.workspace.ownerId,
              generation: view.checkout.nativeGeneration,
            },
            view,
          };
        }).pipe(Effect.provideService(ThreadManagement.ThreadManagementService, threads)),
    });
  }),
);
