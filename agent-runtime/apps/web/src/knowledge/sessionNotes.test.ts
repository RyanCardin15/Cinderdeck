import * as DateTime from "effect/DateTime";
import { beforeEach, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  OrchestrationV2ProjectedTurnItem,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@cinderdeck/contracts";
import { scopeThreadRef, scopeProjectRef } from "@cinderdeck/client-runtime/environment";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import {
  isSessionNote,
  mergeSessionNotes,
  notesFromActivity,
  notesTargetKey,
  useSessionNotesStore,
  type SessionNote,
} from "./sessionNotes";

const env = EnvironmentId.make("local"),
  thread = scopeThreadRef(env, ThreadId.make("one"));
const note: SessionNote = {
  vaultID: "v1",
  vaultName: "Work",
  path: "Projects/Decision.md",
  activity: "viewed",
};
const vault = { id: "v1", name: "Work", path: "/fixtures/vault", workspacePath: null };
const row = (fields: Record<string, unknown>) =>
  Schema.decodeUnknownSync(OrchestrationV2ProjectedTurnItem)({
    position: 0,
    visibility: "local",
    sourceThreadId: "one",
    sourceItemId: "item",
    item: {
      id: "item",
      threadId: "one",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-10-19T10:00:00Z"),
      ...fields,
    },
  });
beforeEach(() => useSessionNotesStore.setState({ byTarget: {} }));
it("keeps session and environment associations separate and records no note bodies", async () => {
  useSessionNotesStore
    .getState()
    .remember(thread, [{ ...note, content: "private markdown" } as SessionNote]);
  expect(useSessionNotesStore.getState().byTarget[notesTargetKey(thread)]).toEqual([note]);
  expect(
    useSessionNotesStore.getState().byTarget[
      notesTargetKey(scopeThreadRef(EnvironmentId.make("remote"), thread.threadId))
    ],
  ).toBeUndefined();
  await useSessionNotesStore.persist.rehydrate();
  expect(useSessionNotesStore.getState().byTarget[notesTargetKey(thread)]).toEqual([note]);
});
it("deduplicates by vault and path and preserves edits when a note is opened again", () => {
  const edited = { ...note, activity: "edited" } as const;
  expect(mergeSessionNotes([edited], [note])).toEqual([edited]);
  const merged = mergeSessionNotes(
    [note],
    [
      { ...note, activity: "attached" },
      { ...note, vaultID: "v2" },
    ],
  );
  expect(merged).toHaveLength(2);
  expect(merged[0]?.activity).toBe("attached");
  expect(mergeSessionNotes(merged, [note])).toBe(merged);
});
it("promotes notes from an actual composer draft, retaining the draft for failed-send recovery", () => {
  const draft = DraftId.make("notes-draft");
  const composer = useComposerDraftStore.getState();
  composer.setProjectDraftThreadId(scopeProjectRef(env, ProjectId.make("p1")), draft, {
    threadId: thread.threadId,
  });
  useSessionNotesStore.getState().remember(draft, [note]);
  composer.markDraftThreadPromoting(draft, thread);
  expect(useSessionNotesStore.getState().byTarget[notesTargetKey(thread)]).toEqual([note]);
  expect(useSessionNotesStore.getState().byTarget[notesTargetKey(draft)]).toEqual([note]);
});
it("discovers only connected-vault Markdown paths from structured read and edit activity", () => {
  const notes = notesFromActivity(
    [
      row({
        type: "dynamic_tool",
        toolName: "Read",
        input: { file_path: "/fixtures/vault/Projects/Decision.md" },
      }),
      row({ type: "file_change", fileName: "Projects/Decision.md" }),
      row({
        type: "file_change",
        fileName: "unused",
        changes: [
          { operation: "update", path: "Research.md" },
          { operation: "update", path: "/fixtures/vault-other/Secret.md" },
          { operation: "update", path: ".obsidian/config.md" },
          { operation: "update", path: "image.png" },
        ],
      }),
      row({ type: "command_execution", input: "cat /fixtures/vault/NotOpened.md" }),
      row({
        type: "dynamic_tool",
        toolName: "unknown",
        input: { file_path: "/fixtures/vault/NotOpened.md" },
      }),
      row({ type: "file_change", fileName: "Failed.md", status: "failed" }),
    ],
    [vault],
    "/fixtures/vault",
  );
  expect(notes.map((n) => [n.path, n.activity])).toEqual([
    ["Projects/Decision.md", "edited"],
    ["Research.md", "edited"],
  ]);
});
it("resolves relative paths and rejects paths that escape a connected vault", () => {
  const result = notesFromActivity(
    [
      row({ type: "file_change", fileName: "../Research.md" }),
      row({ type: "file_change", fileName: "../../Secret.md" }),
    ],
    [vault],
    "/fixtures/vault/Projects",
  );
  expect(result.map((n) => n.path)).toEqual(["Research.md"]);
  expect(isSessionNote({ ...note, path: "../Secret.md" })).toBe(false);
  expect(isSessionNote({ ...note, activity: "__proto__" })).toBe(false);
});
it("handles every file in a multi-file provider change and uses the closest connected vault", () => {
  const changes = Array.from({ length: 15 }, (_, i) => ({
    operation: "update",
    path: `Projects/${i}.md`,
  }));
  const notes = notesFromActivity(
    [row({ type: "file_change", fileName: "unused", changes })],
    [vault, { ...vault, id: "inner", path: "/fixtures/vault/Projects" }],
    vault.path,
  );
  expect(notes).toHaveLength(15);
  expect(notes[0]).toMatchObject({ vaultID: "inner", path: "0.md" });
});
