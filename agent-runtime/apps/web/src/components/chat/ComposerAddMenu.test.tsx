// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { AppContextCapture, DesktopBridge } from "@cinderdeck/contracts";
import { ComposerAddMenu } from "./ComposerAddMenu";

const target = {
  id: "12345678-1234-1234-1234-123456789012",
  bundleID: "com.google.Chrome",
  appName: "Google Chrome",
  windowTitle: "Fixture page",
  tabTitle: "Fixture tab",
  tabURL: "https://example.com/fixture",
  recent: true,
};
const result: AppContextCapture = {
  data: "aW1n",
  mimeType: "image/jpeg",
  source: {
    kind: "snap-shot",
    capturedAt: "2026-10-15T01:00:00Z",
    appName: "Google Chrome",
    windowTitle: "Fixture tab",
    appIdentifier: "com.google.Chrome",
    accessibleText: "URL: https://example.com/fixture",
  },
};
const list = vi.fn();
const capture = vi.fn();
const attach = vi.fn();
const choose = vi.fn();
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  list
    .mockReset()
    .mockResolvedValue({ targets: [target], accessibility: true, screenRecording: true });
  capture.mockReset().mockResolvedValue(result);
  attach.mockReset().mockResolvedValue(undefined);
  choose.mockReset();
  window.desktopBridge = {
    isNativeHost: () => true,
    appContext: { list, capture },
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
async function render(key = "first") {
  await act(async () =>
    root.render(<ComposerAddMenu key={key} onChooseFiles={choose} onAttach={attach} />),
  );
}
async function open() {
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="Add attachments"]')!.click(),
  );
}
async function clickRecent() {
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent?.includes("Add Google Chrome"),
  );
  expect(item).toBeDefined();
  await act(async () => item!.click());
}
it("discovers the recent app on open and captures only after explicit selection", async () => {
  await render();
  expect(list).not.toHaveBeenCalled();
  await open();
  expect(list).toHaveBeenCalledOnce();
  expect(capture).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Fixture tab");
  await clickRecent();
  expect(capture).toHaveBeenCalledWith(target.id);
  expect(attach).toHaveBeenCalledOnce();
  const [file, source] = attach.mock.calls[0]!;
  expect(file.type).toBe("image/jpeg");
  expect(file.size).toBe(3);
  expect(source).toEqual(result.source);
});
it("discards a capture if the user changes conversations before it completes", async () => {
  let finish!: (value: AppContextCapture) => void;
  capture.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await open();
  await clickRecent();
  await render("second");
  await act(async () => finish(result));
  expect(attach).not.toHaveBeenCalled();
});
it("surfaces capture failures and permits another attempt", async () => {
  capture.mockRejectedValueOnce(new Error("The browser tab changed. Open the + menu again."));
  await render();
  await open();
  await clickRecent();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("browser tab changed");
  expect(attach).not.toHaveBeenCalled();
  await open();
  await clickRecent();
  expect(attach).toHaveBeenCalledOnce();
});
it("retains file picking when the native host bridge is absent", async () => {
  delete window.desktopBridge;
  await render();
  await open();
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
    (item) => item.textContent === "Add photos & files",
  );
  await act(async () => item!.click());
  expect(choose).toHaveBeenCalledOnce();
  expect(list).not.toHaveBeenCalled();
});

it("shows native recovery instructions without Electron transport details", async () => {
  const { appContextError } = await import("./ComposerAddMenu");
  expect(
    appContextError(
      new Error(
        "Error invoking remote method 'cinderdeck:app-context': Error: The browser tab changed. Open the + menu again.",
      ),
      "Unavailable",
    ),
  ).toBe("The browser tab changed. Open the + menu again.");
});
