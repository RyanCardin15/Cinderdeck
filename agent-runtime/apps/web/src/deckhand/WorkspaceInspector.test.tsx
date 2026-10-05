// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { WorkspaceInspector } from "./WorkspaceInspector";

let container: HTMLDivElement;
let root: Root;
let shellWidth: number;
let measure: () => void;
const render = async (open = true) => {
  await act(() =>
    root.render(
      <>
        <aside
          ref={(rail) => {
            if (rail) rail.getBoundingClientRect = () => ({ width: 260 }) as DOMRect;
          }}
        />
        <WorkspaceInspector open={open}>
          <input defaultValue="draft" />
        </WorkspaceInspector>
      </>,
    ),
  );
};
const separator = () => container.querySelector<HTMLElement>("[role=separator]")!;
const key = async (value: string, shiftKey = false) => {
  await act(() =>
    separator().dispatchEvent(
      new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true }),
    ),
  );
};
const width = () => Number(separator().getAttribute("aria-valuenow"));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  shellWidth = 1400;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        measure = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  Object.defineProperty(container, "clientWidth", { get: () => shellWidth });
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("resizes with the keyboard, persists width, and preserves drafts across collapse", async () => {
  await render();
  await key("ArrowLeft", true);
  expect(width()).toBe(320);
  expect(window.localStorage.getItem("deckhand:workspace-inspector-width")).toBe("320");
  const input = container.querySelector("input")!;
  input.value = "unsaved draft";
  await render(false);
  expect(container.querySelector<HTMLElement>("#dh-selected-context")?.hidden).toBe(true);
  await render();
  expect(width()).toBe(320);
  expect(container.querySelector("input")?.value).toBe("unsaved draft");
  await act(() => root.unmount());
  root = createRoot(container);
  await render();
  expect(width()).toBe(320);
});

it("clamps to available space without overwriting the preferred width on window resize", async () => {
  await render();
  await key("End");
  expect(width()).toBe(560);
  shellWidth = 1100;
  await act(() => measure());
  expect(width()).toBe(440);
  expect(window.localStorage.getItem("deckhand:workspace-inspector-width")).toBe("560");
  shellWidth = 1400;
  await act(() => measure());
  expect(width()).toBe(560);
  await key("Home");
  await key("ArrowRight");
  expect(width()).toBe(240);
});

it("uses the final pointer position and resets with a double click", async () => {
  await render();
  const handle = separator();
  let captured = false;
  handle.setPointerCapture = () => {
    captured = true;
  };
  handle.hasPointerCapture = () => captured;
  handle.releasePointerCapture = () => {
    captured = false;
  };
  const pointer = (type: string, clientX: number) => {
    const event = new MouseEvent(type, { button: 0, clientX, bubbles: true });
    Object.defineProperty(event, "pointerId", { value: 1 });
    handle.dispatchEvent(event);
  };
  await act(() => {
    pointer("pointerdown", 500);
    pointer("pointerup", 380);
  });
  expect(width()).toBe(400);
  expect(captured).toBe(false);
  expect(window.localStorage.getItem("deckhand:workspace-inspector-width")).toBe("400");
  await act(() => handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(width()).toBe(280);
});
