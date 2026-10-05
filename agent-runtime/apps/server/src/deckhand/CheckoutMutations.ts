import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as WorkspaceBackend from "./WorkspaceBackend.ts";
export { CheckoutMutationError, type MutationInput } from "./WorkspaceBackend.ts";

/** Compatibility facade for Git/checkpoint consumers; the backend validates checkout identity. */
export class CheckoutMutations extends Context.Service<
  CheckoutMutations,
  {
    readonly run: WorkspaceBackend.WorkspaceBackend["Service"]["withCheckout"];
    readonly includeCheckout: WorkspaceBackend.WorkspaceBackend["Service"]["includeCheckout"];
  }
>()("@cinderdeck/server/deckhand/CheckoutMutations") {}
const make = Effect.gen(function* () {
  const backend = yield* WorkspaceBackend.WorkspaceBackend;
  return CheckoutMutations.of({
    run: backend.withCheckout,
    includeCheckout: backend.includeCheckout,
  });
});
export const layer = Layer.effect(CheckoutMutations, make);
