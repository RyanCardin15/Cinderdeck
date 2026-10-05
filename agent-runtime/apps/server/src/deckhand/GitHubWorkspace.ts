import type {
  GitHubWorkspaceInput,
  GitHubWorkspaceResult,
} from "@t3tools/contracts/deckhand/gitHubWorkspace";
import { DeckhandRpcError } from "@t3tools/contracts/deckhand/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CinderdeckClient from "./CinderdeckClient.ts";
import * as IntegrationDiscovery from "./IntegrationDiscovery.ts";
import * as ProcessRunner from "../processRunner.ts";

export class GitHubWorkspace extends Context.Service<
  GitHubWorkspace,
  {
    readonly request: (
      input: GitHubWorkspaceInput,
    ) => Effect.Effect<GitHubWorkspaceResult, DeckhandRpcError>;
  }
>()("t3/deckhand/GitHubWorkspace") {}
const make = Effect.gen(function* () {
  const discovery = yield* IntegrationDiscovery.IntegrationDiscovery;
  const client = yield* CinderdeckClient.CinderdeckClient;
  return GitHubWorkspace.of({
    request: (input) =>
      Effect.gen(function* () {
        // GitHub browsing needs only the authenticated native peer, never its workspace catalog.
        const location = yield* discovery.locate;
        const connection = yield* client.connect(location.socketPath, {
          channel: location.channel,
          executionHostID: location.hostID,
        });
        return yield* client.github(connection, input);
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
export const layer = Layer.effect(GitHubWorkspace, make);
export const layerLive = layer.pipe(
  Layer.provide(CinderdeckClient.layer),
  Layer.provide(
    IntegrationDiscovery.layer.pipe(
      Layer.provideMerge(IntegrationDiscovery.configLayer),
      Layer.provide(IntegrationDiscovery.hostLayer.pipe(Layer.provide(ProcessRunner.layer))),
    ),
  ),
);
