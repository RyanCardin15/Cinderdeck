// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { RefreshButton } from "./refresh-button";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  container.remove();
});
const button = () => container.querySelector("button")!;
const render = (onRefresh: () => Promise<void>) =>
  act(async () => {
    root.render(<RefreshButton label="Refresh fixture" onRefresh={onRefresh} />);
  });

it("keeps fast refreshes perceptible, blocks duplicate clicks, and confirms completion", async () => {
  const refresh = vi.fn(async () => {});
  await render(refresh);
  await act(async () => {
    button().click();
    button().click();
  });
  expect(refresh).toHaveBeenCalledOnce();
  expect(button().disabled).toBe(true);
  expect(button().getAttribute("aria-busy")).toBe("true");
  expect(container.querySelector("svg")?.getAttribute("class")).toContain(
    "motion-safe:visible-animate-spin",
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(450);
  });
  expect(button().disabled).toBe(false);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Refreshed");
});

it("waits for the actual request and allows recovery after a failure", async () => {
  let reject!: (error: Error) => void;
  const refresh = vi.fn(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  await render(refresh);
  await act(async () => {
    button().click();
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(button().disabled).toBe(true);
  await act(async () => {
    reject(new Error("Computer disconnected"));
  });
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Computer disconnected");
  expect(button().disabled).toBe(false);
  refresh.mockResolvedValueOnce();
  await act(async () => {
    button().click();
    await vi.advanceTimersByTimeAsync(450);
  });
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Refreshed");
});
