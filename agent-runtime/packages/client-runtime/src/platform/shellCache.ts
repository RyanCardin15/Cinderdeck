import type { OrchestrationV2ShellSnapshot } from "@cinderdeck/contracts";

/** Thin live shells never erase metadata already available for offline navigation. */
export function mergeDeferredShellCache(
  previous: OrchestrationV2ShellSnapshot | null,
  incoming: OrchestrationV2ShellSnapshot,
  metadataOnly = false,
): OrchestrationV2ShellSnapshot {
  if (previous && previous.snapshotSequence > incoming.snapshotSequence)
    return metadataOnly ? previous : incoming;
  if (!incoming.deferredThreads || !incoming.deferredThreadRefs || !previous) return incoming;
  const membership = new Set(incoming.deferredThreadRefs.map((row) => row.id));
  const threads = new Map(
    previous.threads.filter((row) => membership.has(row.id)).map((row) => [row.id, row]),
  );
  for (const row of incoming.threads) if (membership.has(row.id)) threads.set(row.id, row);
  return { ...incoming, threads: [...threads.values()] };
}
