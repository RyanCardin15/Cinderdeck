// @effect-diagnostics nodeBuiltinImport:off - UUIDs identify durable finite mutation owners.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as NativeWriterReservations from "./NativeWriterReservations.ts";
import * as WriterReservations from "./WriterReservations.ts";
import { CheckoutMutationError, WorkspaceBackend, type MutationInput } from "./WorkspaceBackend.ts";
export { CheckoutMutationError, type MutationInput } from "./WorkspaceBackend.ts";

export class CheckoutMutations extends Context.Service<
  CheckoutMutations,
  {
    readonly run: <A, E, R>(
      input: MutationInput,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | CheckoutMutationError, R>;
  }
>()("t3/deckhand/CheckoutMutations") {}
const make = Effect.gen(function* () {
  const backend = yield* WorkspaceBackend;
  const writers = yield* WriterReservations.WriterReservations;
  const native = yield* NativeWriterReservations.NativeWriterReservations;
  const run: CheckoutMutations["Service"]["run"] = (input, effect) =>
    Effect.gen(function* () {
      const resolved = yield* backend.inspect(input);
      if (resolved === null) return yield* effect;
      const ownerId = `mutation:${NodeCrypto.randomUUID()}`;
      const ownershipScope = yield* Scope.make();
      const processScope = yield* Scope.make();
      let started = false;
      let confirmedStopped = false;
      let releaseUncertain = false;
      return yield* Effect.gen(function* () {
        yield* writers.tryAcquire({ ownerId, physicalIds: resolved.physicalIDs }).pipe(
          Effect.provideService(Scope.Scope, ownershipScope),
          Effect.mapError(
            (error) =>
              new CheckoutMutationError({ reason: error.reason === "busy" ? "busy" : "storage" }),
          ),
        );
        // Revalidate after local admission; aliases and native generations may change
        // while resolving the initial request. Never expand an already acquired scope.
        const fresh = yield* backend.inspect(input);
        if (
          fresh === null ||
          fresh.current.physicalId !== resolved.current.physicalId ||
          fresh.physicalIDs.length !== resolved.physicalIDs.length ||
          fresh.physicalIDs.some((id) => !resolved.physicalIDs.includes(id))
        )
          return yield* new CheckoutMutationError({ reason: "stale_binding" });
        const reserved = new Set<string>();
        let index = 0;
        for (const context of fresh.contexts) {
          const selected = context.repos.filter((_, i) => !reserved.has(context.physicalIDs[i]!));
          if (!selected.length) continue;
          const scope = context.physicalIDs.filter((_, i) => selected.includes(context.repos[i]!));
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const lease = yield* native
                .acquire(`${ownerId}:${index++}`, {
                  cwd: fresh.current.root,
                  physicalId: fresh.current.physicalId,
                  writerScope: [...new Set(scope)],
                  native: {
                    installationID: fresh.installationID!,
                    workspaceID: context.workspaceID,
                    generation: context.generation,
                    revision: context.revision,
                    repos: selected,
                  },
                })
                .pipe(
                  Effect.tapError((error) =>
                    error.reason === "uncertain" || error.reason === "storage"
                      ? writers.uncertain(ownerId).pipe(Effect.orDie)
                      : Effect.void,
                  ),
                  Effect.mapError(
                    (error) =>
                      new CheckoutMutationError({
                        reason: error.reason === "refused" ? "busy" : "uncertain",
                      }),
                  ),
                );
              if (lease !== null)
                yield* Scope.addFinalizer(
                  ownershipScope,
                  Effect.suspend(() =>
                    started && !confirmedStopped
                      ? Effect.void
                      : native.release(lease).pipe(
                          Effect.catch(() =>
                            Effect.gen(function* () {
                              releaseUncertain = true;
                              yield* writers.uncertain(ownerId).pipe(Effect.orDie);
                            }),
                          ),
                        ),
                  ),
                );
              for (const id of scope) reserved.add(id);
            }),
          );
        }
        started = true;
        return yield* effect.pipe(Effect.provideService(Scope.Scope, processScope));
      }).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const closed = yield* Scope.close(processScope, exit).pipe(Effect.exit);
            confirmedStopped = Exit.isSuccess(closed);
            if (!confirmedStopped) yield* writers.uncertain(ownerId).pipe(Effect.orDie);
            yield* Scope.close(ownershipScope, exit);
            if (Exit.isFailure(closed)) return yield* Effect.failCause(closed.cause);
            if (releaseUncertain) return yield* new CheckoutMutationError({ reason: "uncertain" });
          }),
        ),
      );
    });
  return CheckoutMutations.of({ run });
});
export const layer = Layer.effect(CheckoutMutations, make);
