import * as Persistence from "../platform/persistence.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type OrchestrationV2ThreadShell,
} from "@cinderdeck/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentShellState } from "./shell.ts";

class ShellPageCursorError extends Schema.TaggedError<ShellPageCursorError>()(
  "ShellPageCursorError",
  {},
) {}

export interface ShellScope {
  readonly projectIds?: ReadonlyArray<ProjectId>;
  readonly threadIds?: ReadonlyArray<ThreadId>;
}
export type ShellPageRow = {
  readonly shell: OrchestrationV2ThreadShell;
  readonly sequence: number;
};
const EMPTY: ReadonlyArray<OrchestrationV2ThreadShell> = [];
const EMPTY_RESULT = AsyncResult.success<ReadonlyArray<ShellPageRow>>([]);
const NO_REMOVALS: ReadonlyMap<string, number> = new Map();

/** Late pages cannot resurrect a row removed after that individual page was read. */
export function currentPageRows(
  rows: ReadonlyArray<ShellPageRow>,
  removedAt: ReadonlyMap<string, number>,
) {
  return rows
    .filter((row) => (removedAt.get(row.shell.id) ?? -1) <= row.sequence)
    .map((row) => row.shell);
}

const rootIndexes = new WeakMap<
  ReadonlyArray<{ readonly id: ThreadId; readonly rootThreadId?: ThreadId }>,
  ReadonlyMap<ThreadId, ThreadId>
>();
function scopeForState(state: EnvironmentShellState, scope: ShellScope): ShellScope {
  if (scope.threadIds === undefined) return scope;
  const refs = Option.getOrNull(state.snapshot)?.deferredThreadRefs;
  let roots = refs ? rootIndexes.get(refs) : undefined;
  if (!roots) {
    roots = new Map(refs?.map((row) => [row.id, row.rootThreadId ?? row.id]));
    if (refs) rootIndexes.set(refs, roots);
  }
  return {
    ...scope,
    threadIds: [...new Set(scope.threadIds.map((id) => roots.get(id) ?? id))].sort(),
  };
}

/** Shared by desktop and mobile: only mounted scopes hydrate deferred metadata. */
export function createShellPagingAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
  shellState: (id: EnvironmentId) => Atom.Atom<EnvironmentShellState>,
) {
  const query = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-shell-pages",
    idleTtlMs: 60_000,
    staleTimeMs: Infinity,
    execute: (input: { generation: number; scope: ShellScope }) =>
      Effect.gen(function* () {
        const rows: ShellPageRow[] = [];
        let afterId: ThreadId | undefined;
        do {
          const page = yield* request(ORCHESTRATION_V2_WS_METHODS.getShellPage, {
            ...input.scope,
            ...(afterId === undefined ? {} : { afterId }),
          });
          for (const shell of page.threads) rows.push({ shell, sequence: page.snapshotSequence });
          if (page.nextId === null) {
            const cache = yield* Effect.serviceOption(Persistence.EnvironmentCacheStore);
            const supervisor = yield* Effect.serviceOption(
              EnvironmentSupervisor.EnvironmentSupervisor,
            );
            const registry = yield* Effect.serviceOption(AtomRegistry.AtomRegistry);
            if (Option.isSome(cache) && Option.isSome(supervisor) && Option.isSome(registry)) {
              const environmentId = supervisor.value.target.environmentId;
              const state = registry.value.get(shellState(environmentId));
              const snapshot = Option.getOrNull(state.snapshot);
              if (snapshot && state.generation === input.generation) {
                const merged = new Map(
                  currentPageRows(rows, state.removedAt ?? NO_REMOVALS).map((row) => [row.id, row]),
                );
                for (const row of snapshot.threads) merged.set(row.id, row);
                yield* cache.value
                  .saveShell(
                    environmentId,
                    { ...snapshot, threads: [...merged.values()] },
                    { metadataOnly: true },
                  )
                  .pipe(Effect.catch(() => Effect.void));
              }
            }
            return rows;
          }
          if (afterId !== undefined && page.nextId <= afterId)
            return yield* Effect.fail(new ShellPageCursorError());
          afterId = page.nextId;
        } while (true);
      }),
  });
  const resultFamily = Atom.family((key: string) => {
    const [environmentId, scope] = JSON.parse(key) as [EnvironmentId, ShellScope];
    return Atom.make((get) => {
      const state = get(shellState(environmentId));
      return !Option.getOrNull(state.snapshot)?.deferredThreads ||
        !state.generation ||
        state.status === "cached"
        ? EMPTY_RESULT
        : get(
            query({
              environmentId,
              input: { generation: state.generation, scope: scopeForState(state, scope) },
            }),
          );
    });
  });
  const statusFamily = Atom.family((key: string) => {
    const [environmentId, scope] = JSON.parse(key) as [EnvironmentId, ShellScope];
    return Atom.make((get) => {
      const snapshot = Option.getOrNull(get(shellState(environmentId)).snapshot);
      if (
        scope.threadIds !== undefined &&
        !scope.projectIds?.length &&
        scope.threadIds.every((id) => snapshot?.threads.some((row) => row.id === id))
      )
        return EMPTY_RESULT;
      return get(resultFamily(key));
    });
  });
  const family = Atom.family((key: string) => {
    const [environmentId] = JSON.parse(key) as [EnvironmentId, ShellScope];
    let previous: ReadonlyArray<OrchestrationV2ThreadShell> = EMPTY;
    let previousRows: ReadonlyArray<ShellPageRow> | undefined;
    let previousRemovals: ReadonlyMap<string, number> | undefined;
    return Atom.make((get) => {
      const state = get(shellState(environmentId));
      if (
        !Option.getOrNull(state.snapshot)?.deferredThreads ||
        !state.generation ||
        state.status === "cached"
      )
        return EMPTY;
      const result = get(resultFamily(key));
      const sourceRows = Option.getOrElse(AsyncResult.value(result), () => EMPTY_RESULT.value);
      const removals = state.removedAt ?? NO_REMOVALS;
      if (previousRows === sourceRows && previousRemovals === removals) return previous;
      previousRows = sourceRows;
      previousRemovals = removals;
      const rows = currentPageRows(sourceRows, removals);
      if (rows.length === previous.length && rows.every((row, index) => row === previous[index]))
        return previous;
      previous = rows;
      return rows;
    });
  });
  const key = (id: EnvironmentId, scope: ShellScope) =>
    JSON.stringify([
      id,
      {
        ...(scope.projectIds === undefined
          ? {}
          : { projectIds: [...new Set(scope.projectIds)].sort() }),
        ...(scope.threadIds === undefined
          ? {}
          : { threadIds: [...new Set(scope.threadIds)].sort() }),
      },
    ]);
  return Object.assign((id: EnvironmentId, scope: ShellScope) => family(key(id, scope)), {
    resultAtom: (id: EnvironmentId, scope: ShellScope) => resultFamily(key(id, scope)),
    statusAtom: (id: EnvironmentId, scope: ShellScope) => statusFamily(key(id, scope)),
    refresh: (
      registry: import("effect/unstable/reactivity").AtomRegistry.AtomRegistry,
      id: EnvironmentId,
      scope: ShellScope,
    ) => {
      const state = registry.get(shellState(id));
      const generation = state.generation;
      if (generation)
        registry.refresh(
          query({
            environmentId: id,
            input: {
              generation,
              scope: scopeForState(
                state,
                (JSON.parse(key(id, scope)) as [EnvironmentId, ShellScope])[1],
              ),
            },
          }),
        );
    },
  });
}
