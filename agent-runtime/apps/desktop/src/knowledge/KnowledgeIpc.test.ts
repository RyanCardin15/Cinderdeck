// @effect-diagnostics nodeBuiltinImport:off -- Actual files are confined to disposable test roots.
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import { it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import { installKnowledgeIpc } from "./KnowledgeIpc.ts";
const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn().mockResolvedValue(undefined) }));
vi.mock("electron", () => ({ shell: { openExternal } }));
let folder: string, method: DesktopIpc.DesktopIpcMethod<Error, never>;
const frame = {};
const event = { sender: { id: 10 }, senderFrame: frame };
let picked: string | null;
beforeEach(async () => {
  folder = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "knowledge-ipc-")),
  );
  await NodeFSP.mkdir(NodePath.join(folder, ".obsidian"));
  await NodeFSP.writeFile(NodePath.join(folder, "Hello space.md"), "Hello fixture");
  picked = folder;
  openExternal.mockClear();
});
function withKnowledge<A, E>(test: Effect.Effect<A, E>) {
  return installKnowledgeIpc().pipe(
    Effect.andThen(test),
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          stateDir: NodePath.join(folder, "state"),
          homeDirectory: folder,
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
        Layer.succeed(ElectronWindow.ElectronWindow, {
          currentMainOrFirst: Effect.succeed(
            Option.some({ webContents: { id: 10, mainFrame: frame } }),
          ),
        } as unknown as ElectronWindow.ElectronWindow["Service"]),
        Layer.succeed(ElectronDialog.ElectronDialog, {
          pickFolder: () => Effect.succeed(Option.fromNullishOr(picked)),
        } as unknown as ElectronDialog.ElectronDialog["Service"]),
        Layer.succeed(DesktopIpc.DesktopIpc, {
          handle: (input) =>
            Effect.sync(() => {
              method = input as unknown as DesktopIpc.DesktopIpcMethod<Error, never>;
            }),
          handleSync: () => Effect.void,
        } as DesktopIpc.DesktopIpc["Service"]),
      ),
    ),
    Effect.scoped,
  );
}

afterEach(async () => {
  await NodeFSP.rm(folder, { recursive: true, force: true });
});
function invoke(input: unknown, sender = event) {
  return method.handler(input, sender);
}
function expectFailure(input: unknown, message: string, sender = event) {
  return Effect.gen(function* () {
    const cause = yield* Effect.flip(Effect.sandbox(Effect.asVoid(invoke(input, sender))));
    expect(Cause.pretty(cause)).toContain(message);
  });
}
it.effect("routes connect, search, read and OS open through the registered IPC boundary", () =>
  Effect.gen(function* () {
    const vault = (yield* invoke({
      action: "connect-vault",
      name: "Fixture",
      workspacePath: null,
    })) as { id: string };
    const search = (yield* invoke({
      action: "search-notes",
      vaultID: vault.id,
      query: "Hello",
    })) as {
      notes: { path: string }[];
    };
    expect(search.notes[0]?.path).toBe("Hello space.md");
    expect(
      yield* invoke({ action: "read-note", vaultID: vault.id, path: "Hello space.md" }),
    ).toMatchObject({ content: "Hello fixture" });
    yield* invoke({ action: "open-note", vaultID: vault.id, path: "Hello space.md" });
    expect(new URL(openExternal.mock.calls[0]![0]).searchParams.get("path")).toBe(
      NodePath.join(folder, "Hello space.md"),
    );
  }).pipe(withKnowledge),
);
it.effect("rejects guest frames, other windows, malformed and unsupported commands", () =>
  Effect.gen(function* () {
    yield* expectFailure({ action: "list-vaults" }, "main Cinderdeck", {
      sender: { id: 10 },
      senderFrame: {},
    });
    yield* expectFailure({ action: "list-vaults" }, "main Cinderdeck", {
      sender: { id: 11 },
      senderFrame: frame,
    });
    yield* expectFailure({ action: "list-vaults", workspacePath: [] }, "Invalid");
    yield* expectFailure({ action: "execute-shell" }, "Unsupported");
    expect(openExternal).not.toHaveBeenCalled();
  }).pipe(withKnowledge),
);
it.effect("cancels folder selection without persisting a connection", () =>
  Effect.gen(function* () {
    picked = null;
    expect(yield* invoke({ action: "connect-vault", name: "Cancelled" })).toBeNull();
    expect(yield* invoke({ action: "list-vaults" })).toEqual([]);
  }).pipe(withKnowledge),
);
it.effect("preserves actionable store errors at the IPC boundary", () =>
  Effect.gen(function* () {
    yield* invoke({ action: "connect-vault", name: "Fixture", workspacePath: null });
    yield* expectFailure(
      { action: "connect-vault", name: "Duplicate", workspacePath: null },
      "already connected",
    );
    yield* expectFailure(
      { action: "read-note", vaultID: "missing", path: "Hello space.md" },
      "disconnected",
    );
  }).pipe(withKnowledge),
);
