import type { AgentAccessInput, AgentAccessResult } from "@cinderdeck/contracts/deckhand/rpc";
import { DeckhandRpcError } from "@cinderdeck/contracts/deckhand/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CinderdeckClient from "./CinderdeckClient.ts";
import * as IntegrationDiscovery from "./IntegrationDiscovery.ts";
import * as ProcessRunner from "../processRunner.ts";

/** MCP, skills and Claude Code mod setup, performed by Cinderdeck on the execution computer. */
export class AgentAccess extends Context.Service<
  AgentAccess,
  {
    readonly request: (
      input: AgentAccessInput,
    ) => Effect.Effect<AgentAccessResult, DeckhandRpcError>;
  }
>()("@cinderdeck/server/deckhand/AgentAccess") {}

const make = Effect.gen(function* () {
  const discovery = yield* IntegrationDiscovery.IntegrationDiscovery;
  const client = yield* CinderdeckClient.CinderdeckClient;
  return AgentAccess.of({
    request: (input) =>
      Effect.gen(function* () {
        // Setup needs only the authenticated native peer, never its workspace catalog.
        const location = yield* discovery.locate;
        const connection = yield* client.connect(location.socketPath, {
          channel: location.channel,
          executionHostID: location.hostID,
        });
        return yield* client.agentAccess(connection, input);
      }).pipe(
        Effect.mapError(
          (cause) =>
            new DeckhandRpcError({
              reason: cause.detail ?? cause.reason,
              ...(cause.code ? { code: cause.code } : {}),
            }),
        ),
      ),
  });
});
const layer = Layer.effect(AgentAccess, make);
export const layerLive = layer.pipe(
  Layer.provide(CinderdeckClient.layer),
  Layer.provide(
    IntegrationDiscovery.layer.pipe(
      Layer.provideMerge(IntegrationDiscovery.configLayer),
      Layer.provide(IntegrationDiscovery.hostLayer.pipe(Layer.provide(ProcessRunner.layer))),
    ),
  ),
);
