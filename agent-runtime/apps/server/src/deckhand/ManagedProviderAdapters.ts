import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ProviderAdapter from "../orchestration-v2/ProviderAdapter.ts";
import { forceCodexReadOnlyPolicy } from "../orchestration-v2/CodexReadOnlyPolicy.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ManagedCheckoutGuard from "./ManagedCheckoutGuard.ts";
import { workspaceContextText } from "./WorkspaceSessionContext.ts";
const isCheckoutError = Schema.is(ManagedCheckoutGuard.ManagedCheckoutError);

/** Keep provider protocols upstream. Validate checkout identity and read-only policy at provider boundaries. */
export const layer = Layer.effect(
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  Effect.gen(function* () {
    const upstream = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const guard = yield* ManagedCheckoutGuard.ManagedCheckoutGuard;
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
                    if (context?.access === "read_only" && adapter.driver !== "codex")
                      return yield* new ManagedCheckoutGuard.ManagedCheckoutError({
                        threadId: input.threadId,
                        reason: "unsupported_access",
                      });
                    const sessionReadOnly = context?.access === "read_only";
                    const policy = (
                      value: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
                      current: ManagedCheckoutGuard.ManagedContext | null,
                    ) =>
                      current?.access === "read_only"
                        ? forceCodexReadOnlyPolicy({
                            ...value,
                            cwd: current.cwd,
                            ...(current.folders ? { workspaceFolders: current.folders } : {}),
                            ...(current.files ? { workspaceFiles: current.files } : {}),
                          })
                        : {
                            ...value,
                            cwd: current?.cwd ?? value.cwd,
                            ...(current?.folders ? { workspaceFolders: current.folders } : {}),
                            ...(current?.files ? { workspaceFiles: current.files } : {}),
                          };
                    const contexts = new Map<
                      typeof input.threadId,
                      ManagedCheckoutGuard.ManagedContext
                    >();
                    const check = (threadId: typeof input.threadId, cwd: string | null) =>
                      guard.resolve(threadId, cwd).pipe(
                        Effect.flatMap((current) => {
                          const existing = contexts.get(threadId);
                          if (
                            (current?.access === "read_only" && adapter.driver !== "codex") ||
                            (sessionReadOnly && current?.access !== "read_only")
                          )
                            return Effect.fail(
                              new ManagedCheckoutGuard.ManagedCheckoutError({
                                threadId,
                                reason: "unsupported_access",
                              }),
                            );
                          if (
                            existing &&
                            (!current ||
                              current.physicalId !== existing.physicalId ||
                              current.access !== existing.access)
                          )
                            return Effect.fail(
                              new ManagedCheckoutGuard.ManagedCheckoutError({
                                threadId,
                                reason: "wrong_checkout",
                              }),
                            );
                          if (current) contexts.set(threadId, current);
                          return Effect.succeed(current);
                        }),
                        Effect.mapError(
                          (cause) =>
                            new ProviderAdapter.ProviderAdapterProtocolError({
                              driver: adapter.driver,
                              detail: "The session's checkout changed.",
                              cause,
                            }),
                        ),
                      );
                    const admitted = yield* check(
                      input.threadId,
                      context?.cwd ?? input.runtimePolicy.cwd,
                    );
                    const runtime = yield* adapter.openSession({
                      ...input,
                      runtimePolicy: policy(input.runtimePolicy, admitted),
                    });
                    return {
                      ...runtime,
                      ensureThread: (request) =>
                        check(request.threadId, request.runtimePolicy.cwd).pipe(
                          Effect.flatMap((current) =>
                            runtime.ensureThread({
                              ...request,
                              runtimePolicy: policy(request.runtimePolicy, current),
                            }),
                          ),
                        ),
                      resumeThread: (request) => {
                        const threadId = request.threadId ?? request.providerThread.appThreadId;
                        if (threadId === null || threadId === undefined)
                          return Effect.fail(
                            new ProviderAdapter.ProviderAdapterProtocolError({
                              driver: adapter.driver,
                              detail: "A managed session needs an app thread to resume.",
                            }),
                          );
                        return check(
                          threadId,
                          request.runtimePolicy?.cwd ??
                            contexts.get(threadId)?.cwd ??
                            input.runtimePolicy.cwd,
                        ).pipe(
                          Effect.flatMap((current) =>
                            runtime.resumeThread({
                              ...request,
                              runtimePolicy: policy(
                                request.runtimePolicy ?? input.runtimePolicy,
                                current,
                              ),
                            }),
                          ),
                        );
                      },
                      forkThread: (request) =>
                        check(
                          request.targetThreadId,
                          request.runtimePolicy?.cwd ?? input.runtimePolicy.cwd,
                        ).pipe(
                          Effect.flatMap((current) =>
                            runtime.forkThread({
                              ...request,
                              runtimePolicy: policy(
                                request.runtimePolicy ?? input.runtimePolicy,
                                current,
                              ),
                            }),
                          ),
                        ),
                      steerTurn: (request) =>
                        check(
                          request.threadId,
                          contexts.get(request.threadId)?.cwd ?? input.runtimePolicy.cwd,
                        ).pipe(Effect.andThen(runtime.steerTurn(request))),
                      startTurn: (request) =>
                        check(request.threadId, request.runtimePolicy.cwd).pipe(
                          Effect.flatMap((current) =>
                            runtime.startTurn({
                              ...request,
                              message: {
                                ...request.message,
                                text:
                                  (current?.access === "write" && current.folders
                                    ? "This conversation is linked to a Cinderdeck workspace. When starting new-branch work from a primary checkout, use t3_worktree_handoff instead of switching the primary checkout in the shell, unless the user explicitly requests an in-place branch switch. To move this conversation into a worktree, use t3_worktree_handoff; it creates a native lane and transfers the conversation. For an existing worktree, pass adoptExisting: true, its path and branch. Pass continuationPrompt with the remaining task to resume there. Do not use shell git worktree add or cd as a conversation handoff; they do not move its binding.\n\n"
                                    : "") +
                                  workspaceContextText(policy(request.runtimePolicy, current)) +
                                  request.message.text,
                              },
                              runtimePolicy: policy(request.runtimePolicy, current),
                            }),
                          ),
                        ),
                    } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
                  }).pipe(
                    Effect.mapError((cause) =>
                      isCheckoutError(cause)
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
