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
import { ProductNavigation } from "./ProductNavigation";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("keeps workspace tools scoped while pull requests open the shared GitHub browser", async () => {
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
      ["Agents", "/workspaces", { ...scope, tab: "agents" }],
      ["Overview", "/workspaces", { ...scope, tab: "overview" }],
      ["Pull requests", "/pull-requests", { involvement: "all", state: "open", environmentId: "remote" }],
      [
        "Services & runs",
        "/services",
        {
          environment: "remote",
          workspace: "lane",
          expectedGeneration: 7,
          expectedInstallationID: "original",
        },
      ],
      [
        "Recordings",
        "/recordings",
        {
          environment: "remote",
          workspace: "lane",
          expectedGeneration: 7,
          expectedInstallationID: "original",
        },
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
