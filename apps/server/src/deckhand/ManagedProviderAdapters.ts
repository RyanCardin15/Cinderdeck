import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ProviderAdapter from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeKeyedSerialExecutor } from "../orchestration-v2/KeyedSerialExecutor.ts";
import * as ManagedCheckoutGuard from "./ManagedCheckoutGuard.ts";
import * as NativeWriterReservations from "./NativeWriterReservations.ts";
import * as WriterReservations from "./WriterReservations.ts";
const isCheckoutError = Schema.is(ManagedCheckoutGuard.ManagedCheckoutError);
const isNativeWriterError = Schema.is(NativeWriterReservations.NativeWriterError);
const isReservationError = Schema.is(WriterReservations.WriterReservationError);

/** Keep provider protocols upstream. Admission wraps their real process scope. */
export const layer = Layer.effect(
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  Effect.gen(function* () {
    const upstream = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const guard = yield* ManagedCheckoutGuard.ManagedCheckoutGuard;
    const reservations = yield* WriterReservations.WriterReservations;
    const native = yield* NativeWriterReservations.NativeWriterReservations;
    return ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      ...upstream,
      get: (instanceId) =>
        upstream.get(instanceId).pipe(
          Effect.map(
            (adapter) =>
              ({
                ...adapter,
                openSession: (input) =>
                  Effect.gen(function* () {
                    const context = yield* guard.resolve(input.threadId, input.runtimePolicy.cwd);
                    const processScope = yield* Scope.make();
                    const ownership = new Map<
                      typeof input.threadId,
                      {
                        readonly context: ManagedCheckoutGuard.ManagedContext;
                        readonly scope: Scope.Closeable;
                        readonly nativeLease: string | null;
                      }
                    >();
                    const ownershipScopes = new Map<
                      Scope.Closeable,
                      {
                        ownerId: typeof input.threadId;
                        effectsStarted: boolean;
                        confirmedStopped: boolean;
                      }
                    >();
                    const admission = yield* makeKeyedSerialExecutor<typeof input.threadId>();
                    let closing = false;
                    yield* Effect.addFinalizer((exit) =>
                      Effect.gen(function* () {
                        closing = true;
                        const closed = yield* Scope.close(processScope, exit).pipe(Effect.exit);
                        // A failed process finalizer cannot prove shutdown. Retain uncertain
                        // ownership even when the manager retires its live session entry.
                        for (const [scope, owner] of ownershipScopes) {
                          const ownerId = owner.ownerId;
                          owner.confirmedStopped = Exit.isSuccess(closed);
                          if (Exit.isFailure(closed))
                            yield* reservations.uncertain(ownerId).pipe(Effect.orDie);
                          yield* Scope.close(scope, exit);
                        }
                        if (Exit.isFailure(closed)) return yield* Effect.failCause(closed.cause);
                      }),
                    );
                    const check = (threadId: typeof input.threadId, cwd: string | null) =>
                      admission
                        .withLock(
                          threadId,
                          Effect.gen(function* () {
                            if (closing)
                              return yield* new ManagedCheckoutGuard.ManagedCheckoutError({
                                threadId,
                                reason: "unavailable",
                              });
                            const current = yield* guard.resolve(threadId, cwd);
                            const existing = ownership.get(threadId);
                            if (existing !== undefined) {
                              if (
                                current === null ||
                                current.physicalId !== existing.context.physicalId ||
                                current.writerScope.length !==
                                  existing.context.writerScope.length ||
                                current.writerScope.some(
                                  (id) => !existing.context.writerScope.includes(id),
                                )
                              )
                                return yield* new ManagedCheckoutGuard.ManagedCheckoutError({
                                  threadId,
                                  reason: "wrong_checkout",
                                });
                              if (existing.nativeLease !== null)
                                yield* native
                                  .verify(existing.nativeLease, current)
                                  .pipe(
                                    Effect.tapError(() =>
                                      reservations.uncertain(threadId).pipe(Effect.orDie),
                                    ),
                                  );
                              return current;
                            }
                            if (current === null) return null;
                            const scope = yield* Scope.make();
                            const owner = {
                              ownerId: threadId,
                              effectsStarted: false,
                              confirmedStopped: false,
                            };
                            ownershipScopes.set(scope, owner);
                            const cleanup = Scope.close(scope, Exit.void).pipe(
                              Effect.tap(() => Effect.sync(() => ownershipScopes.delete(scope))),
                            );
                            return yield* Effect.gen(function* () {
                              yield* reservations
                                .acquire({ ownerId: threadId, physicalIds: current.writerScope })
                                .pipe(Effect.provideService(Scope.Scope, scope));
                              if (closing)
                                return yield* new ManagedCheckoutGuard.ManagedCheckoutError({
                                  threadId,
                                  reason: "unavailable",
                                });
                              const admitted = yield* guard.resolve(threadId, cwd);
                              if (
                                admitted === null ||
                                admitted.physicalId !== current.physicalId ||
                                admitted.writerScope.length !== current.writerScope.length ||
                                admitted.writerScope.some((id) => !current.writerScope.includes(id))
                              )
                                return yield* new ManagedCheckoutGuard.ManagedCheckoutError({
                                  threadId,
                                  reason: "wrong_checkout",
                                });
                              // Keep acquisition and finalizer registration atomic with cancellation.
                              yield* Effect.uninterruptible(
                                Effect.gen(function* () {
                                  const lease = yield* native
                                    .acquire(threadId, admitted)
                                    .pipe(
                                      Effect.tapError((error) =>
                                        error.reason === "uncertain" || error.reason === "storage"
                                          ? reservations.uncertain(threadId).pipe(Effect.orDie)
                                          : Effect.void,
                                      ),
                                    );
                                  if (lease !== null)
                                    yield* Scope.addFinalizer(
                                      scope,
                                      Effect.suspend(() =>
                                        owner.effectsStarted && !owner.confirmedStopped
                                          ? Effect.void
                                          : native
                                              .release(lease)
                                              .pipe(
                                                Effect.catch(() =>
                                                  reservations
                                                    .uncertain(threadId)
                                                    .pipe(Effect.orDie),
                                                ),
                                              ),
                                      ),
                                    );
                                  ownership.set(threadId, {
                                    context: admitted,
                                    scope,
                                    nativeLease: lease,
                                  });
                                }),
                              );
                              return admitted;
                            }).pipe(
                              Effect.tapError(() => cleanup),
                              Effect.onInterrupt(() => cleanup),
                            );
                          }),
                        )
                        .pipe(
                          Effect.mapError(
                            (cause) =>
                              new ProviderAdapter.ProviderAdapterProtocolError({
                                driver: adapter.driver,
                                detail: "The session's reserved checkout changed.",
                                cause,
                              }),
                          ),
                        );
                    const admitted = yield* check(
                      input.threadId,
                      context?.cwd ?? input.runtimePolicy.cwd,
                    );
                    const startEffects = (threadId: typeof input.threadId) =>
                      Effect.sync(() => {
                        const held = ownership.get(threadId);
                        const owner = held ? ownershipScopes.get(held.scope) : undefined;
                        if (owner) owner.effectsStarted = true;
                      });
                    yield* startEffects(input.threadId);
                    const runtime = yield* adapter
                      .openSession({
                        ...input,
                        runtimePolicy: {
                          ...input.runtimePolicy,
                          cwd: admitted?.cwd ?? input.runtimePolicy.cwd,
                        },
                      })
                      .pipe(Effect.provideService(Scope.Scope, processScope));
                    return {
                      ...runtime,
                      ensureThread: (request) =>
                        check(request.threadId, request.runtimePolicy.cwd).pipe(
                          Effect.andThen(startEffects(request.threadId)),
                          Effect.andThen(runtime.ensureThread(request)),
                        ),
                      resumeThread: (request) => {
                        const threadId = request.threadId ?? request.providerThread.appThreadId;
                        if (threadId === null || threadId === undefined)
                          return Effect.fail(
                            new ProviderAdapter.ProviderAdapterProtocolError({
                              driver: adapter.driver,
                              detail: "A reserved session needs an app thread to resume.",
                            }),
                          );
                        return check(
                          threadId,
                          request.runtimePolicy?.cwd ??
                            ownership.get(threadId)?.context.cwd ??
                            input.runtimePolicy.cwd,
                        ).pipe(
                          Effect.andThen(startEffects(threadId)),
                          Effect.andThen(runtime.resumeThread(request)),
                        );
                      },
                      forkThread: (request) =>
                        check(
                          request.targetThreadId,
                          request.runtimePolicy?.cwd ?? input.runtimePolicy.cwd,
                        ).pipe(
                          Effect.andThen(startEffects(request.targetThreadId)),
                          Effect.andThen(runtime.forkThread(request)),
                        ),
                      startTurn: (request) =>
                        check(request.threadId, request.runtimePolicy.cwd).pipe(
                          Effect.andThen(startEffects(request.threadId)),
                          Effect.andThen(runtime.startTurn(request)),
                        ),
                    } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
                  }).pipe(
                    Effect.mapError((cause) =>
                      isCheckoutError(cause) ||
                      isReservationError(cause) ||
                      isNativeWriterError(cause)
                        ? new ProviderAdapter.ProviderAdapterOpenSessionError({
                            driver: adapter.driver,
                            providerSessionId: input.providerSessionId,
                            cause,
                          })
                        : cause,
                    ),
                  ),
              }) satisfies ProviderAdapter.ProviderAdapterV2Shape,
          ),
        ),
    });
  }),
);
