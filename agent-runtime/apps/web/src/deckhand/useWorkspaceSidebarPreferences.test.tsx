// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useWorkspaceSidebarPreferences } from "./useWorkspaceSidebarPreferences";

let root: Root;
let container: HTMLDivElement;
const states = new Map<string, ReturnType<typeof useWorkspaceSidebarPreferences>>();
function Consumer({ id, storageKey = "fixture" }: { id: string; storageKey?: string }) {
  const state = useWorkspaceSidebarPreferences(storageKey);
  states.set(id, state);
  return <span>{state.preferences.favorites.join(",")}</span>;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  states.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it("shares one snapshot across fifty consumers and composes consecutive writes", async () => {
  const reads = vi.spyOn(Storage.prototype, "getItem");
  await act(async () =>
    root.render(
      <StrictMode>
        {Array.from({ length: 50 }, (_, index) => (
          <Consumer key={index} id={String(index)} />
        ))}
      </StrictMode>,
    ),
  );
  expect(reads.mock.calls.length).toBeLessThanOrEqual(4);
  reads.mockClear();
  await act(async () => {
    states.get("0")!.update((value) => ({ ...value, favorites: [...value.favorites, "one"] }));
    states.get("49")!.update((value) => ({ ...value, favorites: [...value.favorites, "two"] }));
  });
  const snapshot = states.get("0")!.preferences;
  expect(snapshot.favorites).toEqual(["one", "two"]);
  expect([...states.values()].every((state) => state.preferences === snapshot)).toBe(true);
  expect(reads).not.toHaveBeenCalled();
});

it("ignores foreign storage events, refreshes remote changes and reloads after unmount", async () => {
  await act(async () =>
    root.render(
      <>
        <Consumer id="a" />
        <Consumer id="b" storageKey="other" />
      </>,
    ),
  );
  const other = states.get("b")!.preferences;
  const reads = vi.spyOn(Storage.prototype, "getItem");
  await act(async () => {
    localStorage.setItem("fixture", JSON.stringify({ favorites: ["remote"] }));
    window.dispatchEvent(new StorageEvent("storage", { key: "fixture" }));
  });
  expect(states.get("a")!.preferences.favorites).toEqual(["remote"]);
  expect(states.get("b")!.preferences).toBe(other);
  expect(reads).toHaveBeenCalledTimes(1);
  await act(async () => root.render(null));
  localStorage.setItem("fixture", JSON.stringify({ favorites: ["fresh"] }));
  await act(async () => root.render(<Consumer id="a" />));
  expect(states.get("a")!.preferences.favorites).toEqual(["fresh"]);
});

it("keeps all consumers in sync when persistence fails", async () => {
  await act(async () =>
    root.render(
      <>
        <Consumer id="a" />
        <Consumer id="b" />
      </>,
    ),
  );
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("unavailable");
  });
  await act(async () => states.get("a")!.update((value) => ({ ...value, favorites: ["local"] })));
  expect(states.get("a")!.preferences.favorites).toEqual(["local"]);
  expect(states.get("b")!.preferences).toBe(states.get("a")!.preferences);
});
