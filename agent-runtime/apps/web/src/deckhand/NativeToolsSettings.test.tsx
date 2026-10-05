// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const boundary = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: boundary.toast } }));
import { NativeAgentAccessSettings } from "./NativeToolsSettings";

let container: HTMLDivElement;
let root: Root;
function setBridge(value: Pick<NonNullable<Window["desktopBridge"]>, "isNativeHost" | "openNativeTool">) {
  Object.defineProperty(window, "desktopBridge", { configurable: true, value });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.desktopBridge;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("offers execution-computer setup without a local native bridge", async () => {
  await act(async () => root.render(<NativeAgentAccessSettings />));
  expect(container.textContent).toContain("cinderdeck setup --all --skills");
  expect(container.textContent).toContain("execution computer");
  expect(container.querySelector("button")).toBeNull();
});

it("disables setup and explains an unavailable native connection", async () => {
  setBridge({ isNativeHost: () => true });
  await act(async () => root.render(<NativeAgentAccessSettings />));
  expect(container.querySelector("button")!.disabled).toBe(true);
  expect(container.querySelector('[role="status"]')!.textContent).toContain("unavailable");
});

it("opens the original installer once while delivery is pending", async () => {
  let finish!: (accepted: boolean) => void;
  const open = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  setBridge({ isNativeHost: () => true, openNativeTool: open });
  await act(async () => root.render(<NativeAgentAccessSettings />));
  const button = container.querySelector("button")!;
  await act(async () => { button.click(); button.click(); });
  expect(open).toHaveBeenCalledExactlyOnceWith({ surface: "agent-access" });
  expect(button.disabled).toBe(true);
  await act(async () => finish(true));
  expect(button.disabled).toBe(false);
  expect(boundary.toast).not.toHaveBeenCalled();
});

it.each(["refused", "disconnected"])("reports %s delivery and allows retry", async (failure) => {
  const open = vi.fn(async () => {
    if (failure === "disconnected") throw new Error("pipe closed");
    return false;
  });
  setBridge({ isNativeHost: () => true, openNativeTool: open });
  await act(async () => root.render(<NativeAgentAccessSettings />));
  const button = container.querySelector("button")!;
  await act(async () => button.click());
  expect(boundary.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  expect(button.disabled).toBe(false);
});
