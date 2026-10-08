import type { EnvironmentId, VcsRef } from "@cinderdeck/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useDeferredValue, useMemo } from "react";
import { vcsEnvironment } from "../state/vcs";

const LIMIT = 50;

/**
 * Existing refs matching `query` in each repository checkout. Reactive atoms are
 * released (and their requests interrupted) when the query or repositories change.
 */
export function useLaneBranchRefs(
  environmentId: EnvironmentId,
  repositories: ReadonlyArray<{ readonly id: string; readonly path: string }>,
  query: string,
): { readonly refs: ReadonlyMap<string, ReadonlyArray<VcsRef>>; readonly pending: boolean } {
  const deferred = useDeferredValue(query.trim());
  const key = JSON.stringify(repositories.map((repo) => [repo.id, repo.path]));
  const combined = useMemo(() => {
    const targets = (JSON.parse(key) as Array<[string, string]>).filter(([, path]) => path);
    const atoms = targets.map(
      ([id, cwd]) =>
        [
          id,
          vcsEnvironment.listRefs({
            environmentId,
            input: { cwd, ...(deferred ? { query: deferred } : {}), limit: LIMIT },
          }),
        ] as const,
    );
    return Atom.make((get) => atoms.map(([id, atom]) => [id, get(atom)] as const)).pipe(
      Atom.withLabel(`web:lane-branch-refs:${environmentId}:${key}:${deferred}`),
    );
  }, [environmentId, key, deferred]);
  const results = useAtomValue(combined);
  return useMemo(() => {
    const refs = new Map<string, ReadonlyArray<VcsRef>>();
    let pending = deferred !== query.trim();
    for (const [id, result] of results) {
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value) refs.set(id, value.refs);
      if (result.waiting || AsyncResult.isInitial(result)) pending = true;
    }
    return { refs, pending };
  }, [results, deferred, query]);
}
