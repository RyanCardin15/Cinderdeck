// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { WorkspaceSearch } from "./workspaceNavigation";
const boundary = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    children,
    ...props
  }: {
    to: string;
    search?: WorkspaceSearch;
    children: ReactNode;
    className?: string;
  }) => (
    <a
      {...props}
      href={to}
      onClick={(event) => {
        event.preventDefault();
        boundary.navigate({ to, search: search ?? {} });
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock("../components/pullRequest/pullRequestListPreferences", () => ({
  readPullRequestListPreferences: () => ({}),
}));
vi.mock("./NativeToolsSettings", () => ({ NativeToolsMenu: () => null }));
vi.mock("./ProductWorkspaces", () => ({
  ProductWorkspaces: () => (
    <nav aria-label="Workspaces and lanes">
      <a href="/workspaces?workspace=fixture">Fixture workspace</a>
    </nav>
  ),
}));
import { ProductNavigation } from "./ProductNavigation";
import { ProductSidebarLayout, PRODUCT_SIDEBAR_STORAGE_KEY } from "./ProductSidebarLayout";
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("opens app-wide views from a lane without carrying its saved context pins", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const scope = {
    environment: "remote",
    workspace: "primary",
    context: "lane",
    expectedGeneration: 7,
    expectedInstallationID: "original",
  };
  try {
    await act(async () =>
      root.render(<ProductNavigation current="services" workspaceSearch={scope} />),
    );
    for (const [label, to, search] of [
      ["Agents", "/workspaces", { environment: "remote", tab: "agents" }],
      ["Overview", "/workspaces", { environment: "remote", tab: "overview" }],
      ["Services & runs", "/services", { environment: "remote" }],
      ["Recordings", "/recordings", { environment: "remote" }],
      [
        "Pull requests",
        "/pull-requests",
        { involvement: "all", state: "open", environmentId: "remote" },
      ],
    ] as const) {
      const link = [...container.querySelectorAll("a")].find((item) => item.textContent === label)!;
      await act(async () => link.click());
      expect(boundary.navigate).toHaveBeenLastCalledWith({ to, search });
    }
    expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    await act(async () =>
      root.render(
        <ProductNavigation current="services" workspaceSearch={{ environment: "other" }} />,
      ),
    );
    await act(async () =>
      [...container.querySelectorAll("a")].find((item) => item.textContent === "Agents")!.click(),
    );
    expect(boundary.navigate).toHaveBeenLastCalledWith({
      to: "/workspaces",
      search: { environment: "other", tab: "agents" },
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("keeps one expandable sidebar across views and restores its size after relaunch", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  const render = (current: "workspaces" | "inbox") =>
    act(async () =>
      root.render(
        <ProductSidebarLayout>
          <ProductNavigation key={current} current={current} />
        </ProductSidebarLayout>,
      ),
    );
  const separator = () => container.querySelector<HTMLElement>('[role="separator"]')!;
  const button = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  try {
    await render("workspaces");
    expect(container.querySelector('[aria-label="Workspaces and lanes"]')).not.toBeNull();
    // A pointer-down/up within one animation frame must still commit the delta.
    const rail = separator();
    Object.assign(rail, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn(),
    });
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, button: 0 });
      Object.defineProperty(event, "pointerId", { value: 1 });
      rail.dispatchEvent(event);
    };
    await act(async () => {
      pointer("pointerdown", 260);
      pointer("pointerup", 332);
    });
    expect(separator().getAttribute("aria-valuenow")).toBe("332");
    await act(async () => button("Collapse main sidebar").click());
    await render("inbox");
    expect(container.querySelector('aside[data-collapsed="true"]')).not.toBeNull();
    expect(container.querySelector('[role="separator"]')).toBeNull();
    expect(button("Expand main sidebar")).not.toBeNull();
    await act(async () => button("Expand main sidebar").click());
    expect(separator().getAttribute("aria-valuenow")).toBe("332");
    await act(async () =>
      separator().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    expect(separator().getAttribute("aria-valuenow")).toBe("348");
    expect(JSON.parse(localStorage.getItem(PRODUCT_SIDEBAR_STORAGE_KEY)!)).toEqual({
      width: 348,
      collapsed: false,
    });
    await act(async () => root.unmount());
    root = createRoot(container);
    await render("workspaces");
    expect(separator().getAttribute("aria-valuenow")).toBe("348");
    await act(async () => separator().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(separator().getAttribute("aria-valuenow")).toBe("260");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("keeps main views visible above a selected workspace tree", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ProductNavigation current="services" hasWorkspaceTree>
          <nav aria-label="Selected workspace tree">Fixture lane</nav>
        </ProductNavigation>,
      ),
    );
    const views = container.querySelector('[aria-label="Main views"]')!;
    const tree = container.querySelector('[aria-label="Selected workspace tree"]')!;
    expect(views.querySelectorAll("a")).toHaveLength(6);
    expect(views.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelector('[aria-label="Workspaces and lanes"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
