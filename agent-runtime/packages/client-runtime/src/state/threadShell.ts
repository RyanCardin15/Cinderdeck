import type { ShellScope } from "./shellPaging.ts";
import type {
  EnvironmentId,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ArchivedShellSnapshot,
  OrchestrationV2ThreadShell,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
} from "@cinderdeck/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentThreadShell } from "./models.ts";
import { presentThreadShell } from "./models.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import {
  arrayElementsEqual,
  parseProjectRefCollectionKey,
  parseThreadKey,
  projectRefCollectionKey,
  threadKey,
  threadRefsEqual,
} from "./entities.ts";

const EMPTY_THREADS: ReadonlyArray<OrchestrationV2ThreadShell> = Object.freeze([]);
const EMPTY_SCOPED_THREAD_REFS: ReadonlyArray<ScopedThreadRef> = Object.freeze([]);
const EMPTY_THREAD_INDEX: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell> = new Map();
const EMPTY_THREAD_REFS_BY_PROJECT: ReadonlyMap<
  ProjectId,
  ReadonlyArray<ScopedThreadRef>
> = new Map();

export function createEnvironmentThreadShellAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ShellSnapshot | null>;
  readonly additionalThreads?: (
    id: EnvironmentId,
    scope: ShellScope,
  ) => Atom.Atom<ReadonlyArray<OrchestrationV2ThreadShell>>;
  readonly archivedSnapshotAtom?: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ArchivedShellSnapshot | null>;
}) {
  // Point reads and aggregate lists share values without keeping an atom alive
  // for every listed thread. Replaced source objects can be collected.
  const scopedThreads = new WeakMap<
    OrchestrationV2ThreadShell,
    Map<EnvironmentId, EnvironmentThreadShell>
  >();
  const scopedThread = (environmentId: EnvironmentId, thread: OrchestrationV2ThreadShell) => {
    let byEnvironment = scopedThreads.get(thread);
    if (byEnvironment === undefined) {
      byEnvironment = new Map();
      scopedThreads.set(thread, byEnvironment);
    }
    let value = byEnvironment.get(environmentId);
    if (value === undefined) {
      value = presentThreadShell(environmentId, thread);
      byEnvironment.set(environmentId, value);
    }
    return value;
  };

  const environmentThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationV2ThreadShell> =>
        get(input.snapshotAtom(environmentId))?.threads ?? EMPTY_THREADS,
    ).pipe(Atom.withLabel(`environment-threads:${environmentId}`)),
  );

  const environmentThreadIndexAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlyMap<ThreadId, OrchestrationV2ThreadShell> => {
      const threads = get(environmentThreadsAtom(environmentId));
      if (threads.length === 0) {
        return EMPTY_THREAD_INDEX;
      }
      return new Map(threads.map((thread) => [thread.id, thread] as const));
    }).pipe(Atom.withLabel(`environment-thread-index:${environmentId}`)),
  );

  const environmentThreadRefsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<ScopedThreadRef> = [];
    return Atom.make((get) => {
      const snapshot = get(input.snapshotAtom(environmentId));
      const listed = new Map((snapshot?.deferredThreadRefs ?? []).map((row) => [row.id, row]));
      for (const row of get(environmentThreadsAtom(environmentId))) listed.set(row.id, row);
      const next = [...listed.values()].map((thread) => ({
        environmentId,
        threadId: thread.id,
      }));
      if (threadRefsEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-thread-refs:${environmentId}`));
  });

  const environmentThreadRefsByProjectAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyMap<
      ProjectId,
      ReadonlyArray<ScopedThreadRef>
    > = EMPTY_THREAD_REFS_BY_PROJECT;
    return Atom.make((get) => {
      const grouped = new Map<ProjectId, ScopedThreadRef[]>();
      const listed = new Map(
        (get(input.snapshotAtom(environmentId))?.deferredThreadRefs ?? []).map((row) => [
          row.id,
          row,
        ]),
      );
      for (const row of get(environmentThreadsAtom(environmentId))) listed.set(row.id, row);
      for (const thread of listed.values()) {
        const refs = grouped.get(thread.projectId);
        const ref = { environmentId, threadId: thread.id };
        if (refs === undefined) {
          grouped.set(thread.projectId, [ref]);
        } else {
          refs.push(ref);
        }
      }
      if (grouped.size === 0) {
        previous = EMPTY_THREAD_REFS_BY_PROJECT;
        return previous;
      }
      const next = new Map<ProjectId, ReadonlyArray<ScopedThreadRef>>();
      for (const [projectId, refs] of grouped) {
        const previousRefs = previous.get(projectId);
        next.set(
          projectId,
          previousRefs !== undefined && threadRefsEqual(previousRefs, refs) ? previousRefs : refs,
        );
      }
      const previousProjectIds = [...previous.keys()];
      if (
        next.size === previous.size &&
        [...next].every(
          ([projectId, refs], index) =>
            previousProjectIds[index] === projectId && previous.get(projectId) === refs,
        )
      ) {
        return previous;
      }
      previous = next;
      return previous;
    }).pipe(Atom.withLabel(`environment-thread-refs-by-project:${environmentId}`));
  });

  // Archives remain out of active lists, but exact conversation links must resolve.
  // Read archived metadata lazily, without hydrating any other thread's transcript.
  const archivedThreadIndexAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlyMap<ThreadId, OrchestrationV2ThreadShell> => {
      const snapshot = input.archivedSnapshotAtom
        ? get(input.archivedSnapshotAtom(environmentId))
        : null;
      return snapshot
        ? new Map(
            snapshot.threads
              .filter((thread) => thread.archivedAt !== null && thread.deletedAt === null)
              .map((thread) => [thread.id, thread]),
          )
        : EMPTY_THREAD_INDEX;
    }),
  );

  const threadShellAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get) => {
      const deferredRef = get(input.snapshotAtom(ref.environmentId))?.deferredThreadRefs?.find(
        (row) => row.id === ref.threadId,
      );
      const source =
        get(environmentThreadIndexAtom(ref.environmentId)).get(ref.threadId) ??
        (input.additionalThreads
          ? get(
              input.additionalThreads(ref.environmentId, {
                projectIds: [],
                threadIds: [deferredRef?.rootThreadId ?? ref.threadId],
              }),
            ).find((row) => row.id === ref.threadId)
          : undefined) ??
        (deferredRef ? null : get(archivedThreadIndexAtom(ref.environmentId)).get(ref.threadId)) ??
        null;
      return source === null ? null : scopedThread(ref.environmentId, source);
    }).pipe(Atom.withLabel(`environment-thread-shell:${key}`));
  });

  const threadShellsForProjectRefsAtomFamily = Atom.family((key: string) => {
    const projectRefs = parseProjectRefCollectionKey(key);
    let previous: ReadonlyArray<EnvironmentThreadShell> = [];
    return Atom.make((get) => {
      const next: EnvironmentThreadShell[] = [];
      const seen = new Set<string>();
      for (const projectRef of projectRefs) {
        const refs =
          get(environmentThreadRefsByProjectAtom(projectRef.environmentId)).get(
            projectRef.projectId,
          ) ?? EMPTY_SCOPED_THREAD_REFS;
        const threads = get(environmentThreadIndexAtom(projectRef.environmentId));
        for (const ref of refs) {
          const key = threadKey(ref);
          if (seen.has(key)) {
            continue;
          }
          const thread = threads.get(ref.threadId);
          if (thread !== undefined) {
            seen.add(key);
            next.push(scopedThread(ref.environmentId, thread));
          }
        }
      }
      if (input.additionalThreads)
        for (const projectRef of projectRefs) {
          for (const row of get(
            input.additionalThreads(projectRef.environmentId, {
              projectIds: [projectRef.projectId],
            }),
          )) {
            const key = threadKey({ environmentId: projectRef.environmentId, threadId: row.id });
            const latest = get(environmentThreadIndexAtom(projectRef.environmentId)).get(row.id);
            if (latest && latest.projectId !== projectRef.projectId) continue;
            if (!seen.has(key)) {
              seen.add(key);
              next.push(scopedThread(projectRef.environmentId, latest ?? row));
            }
          }
        }
      if (arrayElementsEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return previous;
    }).pipe(Atom.withLabel(`environment-thread-shells-for-projects:${key}`));
  });

  // Compose existing project and point selectors instead of subscribing a workspace
  // view to the global shell list. Saved threads can outlive project membership.
  const threadShellsForScopeAtomFamily = Atom.family((key: string) => {
    const [projectKeys, threadKeys] = JSON.parse(key) as [string, string[]];
    let previous: ReadonlyArray<EnvironmentThreadShell> = [];
    return Atom.make((get) => {
      const next = new Map<string, EnvironmentThreadShell>();
      for (const thread of get(threadShellsForProjectRefsAtomFamily(projectKeys))) {
        next.set(threadKey({ environmentId: thread.environmentId, threadId: thread.id }), thread);
      }
      for (const key of threadKeys) {
        if (next.has(key)) continue;
        const thread = get(threadShellAtomFamily(key));
        if (thread) next.set(key, thread);
      }
      const values = [...next.values()];
      if (arrayElementsEqual(previous, values)) return previous;
      previous = values;
      return values;
    }).pipe(Atom.withLabel(`environment-thread-shells-for-scope:${key}`));
  });

  let previousThreadRefs: ReadonlyArray<ScopedThreadRef> = [];
  const threadRefsAtom = Atom.make((get) => {
    const refs: ScopedThreadRef[] = [];
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      refs.push(...get(environmentThreadRefsAtom(environmentId)));
    }
    if (threadRefsEqual(previousThreadRefs, refs)) {
      return previousThreadRefs;
    }
    previousThreadRefs = refs;
    return refs;
  }).pipe(Atom.withLabel("environment-thread-refs"));

  let previousThreadShells: ReadonlyArray<EnvironmentThreadShell> = [];
  const threadShellsAtom = Atom.make((get) => {
    const next: EnvironmentThreadShell[] = [];
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      for (const thread of get(environmentThreadsAtom(environmentId))) {
        next.push(scopedThread(environmentId, thread));
      }
    }
    if (input.additionalThreads)
      for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
        const seen = new Set(
          next.filter((row) => row.environmentId === environmentId).map((row) => row.id),
        );
        for (const row of get(input.additionalThreads(environmentId, {}))) {
          if (!seen.has(row.id)) next.push(scopedThread(environmentId, row));
        }
      }
    if (arrayElementsEqual(previousThreadShells, next)) {
      return previousThreadShells;
    }
    previousThreadShells = next;
    return previousThreadShells;
  }).pipe(Atom.withLabel("environment-thread-shell-list"));

  let previousNavigationShells: ReadonlyArray<EnvironmentThreadShell> = [];
  const navigationThreadShellsAtom = Atom.make((get) => {
    const next: EnvironmentThreadShell[] = [];
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      for (const thread of get(environmentThreadsAtom(environmentId))) {
        if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent")
          continue;
        next.push(scopedThread(environmentId, thread));
      }
    }
    if (input.additionalThreads)
      for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
        const seen = new Set(get(environmentThreadIndexAtom(environmentId)).keys());
        for (const row of get(input.additionalThreads(environmentId, {}))) {
          if (!seen.has(row.id) && row.lineage.relationshipToParent !== "subagent")
            next.push(scopedThread(environmentId, row));
        }
      }
    if (arrayElementsEqual(previousNavigationShells, next)) return previousNavigationShells;
    previousNavigationShells = next;
    return next;
  }).pipe(Atom.withLabel("environment-navigation-thread-shells"));

  return {
    environmentThreadsAtom,
    environmentThreadIndexAtom,
    environmentThreadRefsAtom,
    environmentThreadRefsByProjectAtom,
    threadRefsAtom,
    threadShellsAtom,
    navigationThreadShellsAtom,
    threadShellsForProjectRefsAtom: (refs: ReadonlyArray<ScopedProjectRef>) =>
      threadShellsForProjectRefsAtomFamily(projectRefCollectionKey(refs)),
    threadShellsForScopeAtom: (
      projects: ReadonlyArray<ScopedProjectRef>,
      threads: ReadonlyArray<ScopedThreadRef>,
    ) =>
      threadShellsForScopeAtomFamily(
        JSON.stringify([
          projectRefCollectionKey(projects),
          [...new Set(threads.map(threadKey))].sort(),
        ]),
      ),
    threadShellAtom: (ref: ScopedThreadRef) => threadShellAtomFamily(threadKey(ref)),
  };
}
