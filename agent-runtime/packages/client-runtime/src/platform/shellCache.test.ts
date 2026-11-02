import { expect, it } from "vite-plus/test";
import { ThreadId } from "@cinderdeck/contracts";
import { v2ShellSnapshot, v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import { mergeDeferredShellCache } from "./shellCache.ts";

it("keeps offline metadata for deferred members, removes missing members and lets fresh data win", () => {
  const removed = { ...v2ThreadShell, id: ThreadId.make("removed") };
  const previous = { ...v2ShellSnapshot, snapshotSequence: 1, threads: [v2ThreadShell, removed] };
  const thin = {
    ...v2ShellSnapshot,
    snapshotSequence: 2,
    threads: [],
    deferredThreads: true,
    deferredThreadRefs: [{ id: v2ThreadShell.id, projectId: v2ThreadShell.projectId }],
  };
  expect(mergeDeferredShellCache(previous, thin).threads).toEqual([v2ThreadShell]);
  const updated = { ...v2ThreadShell, title: "Fresh page" };
  expect(mergeDeferredShellCache(previous, { ...thin, threads: [updated] }, true).threads).toEqual([
    updated,
  ]);
  expect(previous.threads).toEqual([v2ThreadShell, removed]);
});
it("ignores late metadata-only writes and treats full or rewound authoritative snapshots as replacements", () => {
  const previous = { ...v2ShellSnapshot, snapshotSequence: 100 };
  const old = {
    ...v2ShellSnapshot,
    snapshotSequence: 90,
    threads: [],
    deferredThreads: true,
    deferredThreadRefs: [],
  };
  expect(mergeDeferredShellCache(previous, old, true)).toBe(previous);
  expect(mergeDeferredShellCache(previous, old)).toBe(old);
  const full = { ...v2ShellSnapshot, snapshotSequence: 101, threads: [] };
  expect(mergeDeferredShellCache(previous, full)).toBe(full);
});
