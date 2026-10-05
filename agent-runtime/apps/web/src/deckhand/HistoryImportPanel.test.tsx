// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId } from "@cinderdeck/contracts";
import type * as C from "@cinderdeck/contracts/deckhand/historyImportRpc";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const commands = vi.hoisted(() => ({
  copy: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  threads: vi.fn(),
  messages: vi.fn(),
  text: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@cinderdeck/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_: unknown, { tag }: { tag: string }) => tag,
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (tag: string) =>
    ({
      "deckhand.history.import": commands.copy,
      "deckhand.history.get": commands.get,
      "deckhand.history.list": commands.list,
      "deckhand.history.threads": commands.threads,
      "deckhand.history.messages": commands.messages,
      "deckhand.history.messageText": commands.text,
      "deckhand.history.remove": commands.remove,
    })[tag],
}));
vi.mock("../lib/utils", () => ({ randomUUID: () => "explicit-copy-key" }));
import { HistoryArchiveBrowser } from "./HistoryImportPanel";
const report: C.HistoryImportReport = {
  importID: "a".repeat(64),
  state: "ready",
  sourceLabel: "statev2.sqlite",
  sourceSha256: "b".repeat(64),
  sourceSchemaVersion: 56,
  archiveSchemaVersion: 1,
  createdAt: "2026-10-04",
  finishedAt: "2026-10-04",
  threads: 1,
  messages: 1,
  attachmentsNotCopied: 1,
  historyOnly: true,
  providerContinuation: "unsupported",
  detail: "History copied into a separate read-only archive.",
  exclusions: ["credentials and auth sessions", "pending work"],
};
let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
  for (const command of Object.values(commands)) command.mockReset();
  commands.list.mockResolvedValue({
    _tag: "Success",
    value: { items: [report], total: 1, nextOffset: null },
  });
  commands.threads.mockResolvedValue({
    _tag: "Success",
    value: {
      items: [
        {
          threadID: "original-thread",
          projectID: "original-project",
          title: "Earlier review",
          provider: "claude",
          createdAt: "2026-01-01",
          updatedAt: "2026-01-02",
          archived: false,
          deleted: false,
          messageCount: 1,
        },
      ],
      total: 1,
      nextOffset: null,
    },
  });
  commands.messages.mockResolvedValue({
    _tag: "Success",
    value: {
      items: [
        {
          messageID: "original-message",
          threadID: "original-thread",
          role: "assistant",
          createdAt: "2026-01-02",
          text: "Saved text…",
          totalCharacters: 40,
          nextTextOffset: 11,
          attachmentsNotCopied: 1,
        },
      ],
      total: 1,
      nextOffset: null,
    },
  });
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});
const render = () =>
  act(async () =>
    root.render(<HistoryArchiveBrowser environmentID={EnvironmentId.make("chosen-computer")} />),
  );
const button = (label: string) =>
  Array.from(element.querySelectorAll("button")).find((item) => item.textContent === label)!;
it("reads real preserved history IDs and more text without provider/session controls", async () => {
  await render();
  expect(commands.copy).not.toHaveBeenCalled();
  await act(async () => button("statev2.sqliteready · 1 threads · 1 messages").click());
  await act(async () => button("Earlier reviewclaude · 1 messages").click());
  expect(element.textContent).toContain("original-thread");
  expect(element.textContent).toContain("Saved text…");
  expect(element.textContent).toContain("original files are unavailable");
  expect(commands.messages).toHaveBeenCalledWith({
    environmentId: "chosen-computer",
    input: { importID: report.importID, threadID: "original-thread", offset: 0, limit: 20 },
  });
  commands.text.mockResolvedValue({
    _tag: "Success",
    value: { text: " remaining original text", totalCharacters: 40, nextOffset: null },
  });
  await act(async () => button("Read more of this message").click());
  expect(element.textContent).toContain("Saved text… remaining original text");
  expect(commands.text).toHaveBeenCalledWith({
    environmentId: "chosen-computer",
    input: { importID: report.importID, messageID: "original-message", offset: 11, limit: 32768 },
  });
  expect(element.querySelectorAll("a")).toHaveLength(0);
  expect(element.textContent).not.toMatch(/Resume agent|Stop agent|Start provider/);
});
it("copies only after explicit action on the selected computer and shows failed schema reports", async () => {
  await render();
  const input = element.querySelector("input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "/owned/t3/statev2.sqlite");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(commands.copy).not.toHaveBeenCalled();
  commands.copy.mockResolvedValue({
    _tag: "Success",
    value: {
      ...report,
      state: "failed",
      sourceSchemaVersion: 57,
      threads: 0,
      messages: 0,
      detail: "This Cinderdeck schema is not supported.",
    },
  });
  await act(async () => button("Copy Cinderdeck history").click());
  expect(commands.copy).toHaveBeenCalledWith({
    environmentId: "chosen-computer",
    input: { operationKey: "explicit-copy-key", sourceDatabasePath: "/owned/t3/statev2.sqlite" },
  });
  expect(element.textContent).toContain("This Cinderdeck schema is not supported.");
  expect(commands.threads).not.toHaveBeenCalled();
  expect(element.textContent).not.toContain("Earlier review");
});
