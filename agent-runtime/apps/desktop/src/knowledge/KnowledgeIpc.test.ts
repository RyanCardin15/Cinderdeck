// @effect-diagnostics nodeBuiltinImport:off -- Actual files are confined to disposable test roots.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
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
  folder = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-ipc-")));
  await fs.mkdir(path.join(folder, ".obsidian"));
  await fs.writeFile(path.join(folder, "Hello space.md"), "Hello fixture");
  picked = folder;
  openExternal.mockClear();
  await Effect.runPromise(
    installKnowledgeIpc().pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
        stateDir: path.join(folder, "state"),
        homeDirectory: folder,
      } as DesktopEnvironment.DesktopEnvironment["Service"]),
      Effect.provideService(ElectronWindow.ElectronWindow, {
        currentMainOrFirst: Effect.succeed(
          Option.some({ webContents: { id: 10, mainFrame: frame } }),
        ),
      } as unknown as ElectronWindow.ElectronWindow["Service"]),
      Effect.provideService(ElectronDialog.ElectronDialog, {
        pickFolder: () => Effect.succeed(Option.fromNullishOr(picked)),
      } as unknown as ElectronDialog.ElectronDialog["Service"]),
      Effect.provideService(DesktopIpc.DesktopIpc, {
        handle: (input) =>
          Effect.sync(() => {
            method = input as unknown as DesktopIpc.DesktopIpcMethod<Error, never>;
          }),
        handleSync: () => Effect.void,
      } as DesktopIpc.DesktopIpc["Service"]),
      Effect.scoped,
    ),
  );
});
afterEach(async () => {
  await fs.rm(folder, { recursive: true, force: true });
});
async function invoke(input: unknown, sender = event) {
  return Effect.runPromise(method.handler(input, sender));
}
it("routes connect, search, read and OS open through the registered IPC boundary", async () => {
  const vault = (await invoke({
    action: "connect-vault",
    name: "Fixture",
    workspacePath: null,
  })) as { id: string };
  const search = (await invoke({ action: "search-notes", vaultID: vault.id, query: "Hello" })) as {
    notes: { path: string }[];
  };
  expect(search.notes[0]?.path).toBe("Hello space.md");
  expect(
    await invoke({ action: "read-note", vaultID: vault.id, path: "Hello space.md" }),
  ).toMatchObject({ content: "Hello fixture" });
  await invoke({ action: "open-note", vaultID: vault.id, path: "Hello space.md" });
  expect(new URL(openExternal.mock.calls[0]![0]).searchParams.get("path")).toBe(
    path.join(folder, "Hello space.md"),
  );
});
it("rejects guest frames, other windows, malformed and unsupported commands", async () => {
  await expect(
    invoke({ action: "list-vaults" }, { sender: { id: 10 }, senderFrame: {} }),
  ).rejects.toThrow("main Cinderdeck");
  await expect(
    invoke({ action: "list-vaults" }, { sender: { id: 11 }, senderFrame: frame }),
  ).rejects.toThrow("main Cinderdeck");
  await expect(invoke({ action: "list-vaults", workspacePath: [] })).rejects.toThrow("Invalid");
  await expect(invoke({ action: "execute-shell" })).rejects.toThrow("Unsupported");
  expect(openExternal).not.toHaveBeenCalled();
});
it("cancels folder selection without persisting a connection", async () => {
  picked = null;
  expect(await invoke({ action: "connect-vault", name: "Cancelled" })).toBeNull();
  expect(await invoke({ action: "list-vaults" })).toEqual([]);
});
it("preserves actionable store errors at the IPC boundary", async () => {
  await invoke({ action: "connect-vault", name: "Fixture", workspacePath: null });
  await expect(
    invoke({ action: "connect-vault", name: "Duplicate", workspacePath: null }),
  ).rejects.toThrow("already connected");
  await expect(
    invoke({ action: "read-note", vaultID: "missing", path: "Hello space.md" }),
  ).rejects.toThrow("disconnected");
});
