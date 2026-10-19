import type { EnvironmentId, ProjectEntry } from "@cinderdeck/contracts";
import { executeAtomQuery } from "@cinderdeck/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { useEffect, useState } from "react";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { useDebouncedValue } from "~/state/queries";
import type { WorkspaceFileRoot } from "./workspaceFileRoots";

/** Search each configured folder, including folders that have never been expanded. */
export function useWorkspacePathSearch(
  environmentId: EnvironmentId,
  roots: readonly WorkspaceFileRoot[],
  query: string,
) {
  const term = query.trim().slice(0, 256);
  const debounced = useDebouncedValue(term, 150);
  const [revision, setRevision] = useState(0);
  const searchKey = JSON.stringify([environmentId, roots, debounced, revision]);
  const [result, setResult] = useState({
    key: null as string | null,
    entries: [] as ProjectEntry[],
    error: null as string | null,
    truncated: false,
  });
  useEffect(() => {
    if (!debounced) return;
    let cancelled = false;
    const controller = new AbortController();
    let next = 0;
    const entries: ProjectEntry[] = roots
      .filter((root) => root.treePath.toLowerCase().includes(debounced.toLowerCase()))
      .map((root) => ({ path: root.treePath, kind: root.kind }));
    const folders = roots.filter((root) => root.kind === "directory");
    const errors: string[] = [];
    let truncated = false;
    const worker = async () => {
      while (next < folders.length) {
        if (cancelled) return;
        const root = folders[next++]!;
        const response = await executeAtomQuery(
          appAtomRegistry,
          projectEnvironment.searchEntries({
            environmentId,
            input: { cwd: root.path, query: debounced, limit: 200 },
          }),
          {
            refresh: revision > 0,
            reportFailure: false,
            reportDefect: false,
            signal: controller.signal,
          },
        );
        if (cancelled) return;
        if (response._tag === "Success") {
          entries.push(
            ...response.value.entries.map((entry) => ({
              ...entry,
              path: `${root.treePath}/${entry.path}`,
            })),
          );
          truncated ||= response.value.truncated;
        } else {
          const error = Cause.squash(response.cause);
          errors.push(`${root.path}: ${error instanceof Error ? error.message : "Search failed."}`);
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, folders.length) }, worker)).then(() => {
      if (!cancelled)
        setResult({ key: searchKey, entries, error: errors.join("\n") || null, truncated });
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [debounced, environmentId, revision, roots, searchKey]);
  const current = Boolean(term) && term === debounced && result.key === searchKey;
  return {
    entries: current ? result.entries : [],
    error: current ? result.error : null,
    truncated: current && result.truncated,
    isPending: Boolean(term) && !current,
    refresh: () => setRevision((value) => value + 1),
  };
}
