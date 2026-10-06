// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import type { DesktopBridge, DictationEvent } from "@cinderdeck/contracts";
import { DictationButton } from "./DictationButton";
vi.mock("../../lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/utils")>()),
  randomUUID: () => "12345678-1234-1234-1234-123456789012",
}));
let root: Root;
let container: HTMLDivElement;
let receive: (event: DictationEvent) => void;
const command = vi.fn(async () => true);
const insert = vi.fn(() => true);
const requestID = "12345678-1234-1234-1234-123456789012";
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  command.mockClear();
  insert.mockClear();
  window.desktopBridge = {
    isNativeHost: () => true,
    dictation: command,
    onDictation: (listener: (event: DictationEvent) => void) => {
      receive = listener;
      return () => {};
    },
  } as unknown as DesktopBridge;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.desktopBridge;
  vi.unstubAllGlobals();
});
async function render(draft = "Existing draft") {
  await act(async () => root.render(<DictationButton draft={draft} insert={insert} />));
}
async function start() {
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Start dictation"]')!.click(),
  );
}
it("stops and inserts only its own completed transcript", async () => {
  await render();
  await start();
  await act(async () => receive({ requestID: "other", state: "completed", text: "Wrong thread" }));
  expect(insert).not.toHaveBeenCalled();
  await act(async () => receive({ requestID, state: "recording" }));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Stop dictation"]')!.click(),
  );
  expect(command).toHaveBeenLastCalledWith({ action: "stop", requestID });
  await act(async () => receive({ requestID, state: "completed", text: "Hello world" }));
  expect(insert).toHaveBeenCalledWith("Hello world", "Existing draft");
});
it("preserves edits and provides the transcript for recovery", async () => {
  await render();
  await start();
  await render("Edited draft");
  await render("Existing draft");
  await act(async () => receive({ requestID, state: "completed", text: "Keep this speech" }));
  expect(insert).not.toHaveBeenCalled();
  expect(container.querySelector("textarea")?.value).toBe("Keep this speech");
});
it("cancels an in-flight capture when navigating away", async () => {
  await render();
  await start();
  await act(async () => root.render(null));
  expect(command).toHaveBeenLastCalledWith({ action: "cancel", requestID });
});
it("shows native permission failures and allows another attempt", async () => {
  await render();
  await start();
  await act(async () => receive({ requestID, state: "error", error: "Allow microphone access" }));
  expect(container.textContent).toContain("Allow microphone access");
  expect(
    container.querySelector<HTMLButtonElement>('[aria-label="Start dictation"]')?.disabled,
  ).toBe(false);
});
