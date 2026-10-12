// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import type { IntegrationView, OverviewPageInput } from "@cinderdeck/contracts/deckhand/rpc";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const boundary = vi.hoisted(() => ({
  navigate: vi.fn(),
  refresh: vi.fn(),
  requests: [] as (typeof OverviewPageInput.Type)[],
  stale: false,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => boundary.navigate,
  Link: ({
    search,
    children,
    to: _to,
    ...props
  }: {
    search: unknown;
    children: ReactNode;
    to: string;
  }) => (
    <a
      {...props}
      href="/workspaces"
      onClick={(event) => {
        event.preventDefault();
        boundary.navigate(search);
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./SettingsScopeContext", () => ({ useSettingsScope: () => ({ search: {} }) }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "computer" }] }),
  usePrimaryEnvironmentId: () => "computer",
}));
vi.mock("../../deckhand/useAgentObservation", () => ({
  useAgentObservation: () => ({ stale: boundary.stale }),
}));
const catalog = Atom.make<AsyncResult.AsyncResult<IntegrationView, Error>>(AsyncResult.initial());
const pages = new Map<string, typeof catalog>();
vi.mock("../../deckhand/state", () => ({
  refreshWorkspaces: "refresh",
  workspaceView: ({ input }: { input: typeof OverviewPageInput.Type }) => {
    boundary.requests.push(input);
    return pages.get(`${input.selectedWorkspaceID}:${input.workspacePage?.offset}`) ?? catalog;
  },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => boundary.refresh }));
import { WorkspacesSettings } from "./WorkspacesSettings";
type Resource = IntegrationView["resources"][number];
const resource = (id: string, source?: string): Resource => ({
  workspaceID: id,
  generation: 3,
  revision: "revision",
  available: true,
  workspace: {
    id,
    name: id,
    file: `/fixture/${id}.toml`,
    state: "ready",
    definitionChanged: false,
    issues: [],
    services: [],
    files: ["/fixture/project-notes.md"],
    repos: [
      {
        id: "app",
        path: `/fixture/${id}`,
        branch: source ? "feature/work" : "main",
        dirty: false,
        changedFiles: 0,
        ahead: 0,
        behind: 0,
      },
    ],
    ...(source
      ? {
          lane: {
            name: id,
            sourceStackID: source,
            directory: `/fixture/${id}`,
            createdAt: "2026-10-05T00:00:00Z",
            ports: {},
          },
        }
      : {}),
  },
});
const alpha = resource("alpha"),
  beta = resource("beta"),
  laneA = resource("lane-a", "alpha"),
  laneB = resource("lane-b", "beta");
const view: IntegrationView = {
  state: "connected",
  observedAt: "2026-10-05T00:00:00Z",
  error: null,
  hello: {
    protocolVersion: 1,
    installationID: "install",
    executionHostID: "host",
    channel: "development",
    runtimeEpoch: "epoch",
    capabilities: [],
    maximumFrameBytes: 4194304,
    maximumPageSize: 100,
    maximumWaitMs: 30000,
  },
  resources: [alpha, beta],
  activity: [],
  total: 2,
  nextOffset: null,
};
const scoped = (
  source: Resource,
  lanes: Resource[],
  nextOffset: number | null = null,
): IntegrationView => ({
  ...view,
  resources: [beta, laneB],
  selectedResources: [source],
  workspaceContexts: {
    workspaceID: source.workspaceID,
    resources: [source, ...lanes],
    total: lanes.length + 1,
    laneCount: lanes.length,
    offset: 0,
    nextOffset,
  },
});
let container: HTMLDivElement, root: Root, registry: AtomRegistry.AtomRegistry;
const openNativeTool = vi.fn(async () => true);
const render = () =>
  act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <WorkspacesSettings />
      </RegistryContext.Provider>,
    ),
  );
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const click = (label: string) => act(async () => button(label).click());
function setPage(key: string, value: IntegrationView) {
  const atom = Atom.make<AsyncResult.AsyncResult<IntegrationView, Error>>(
    AsyncResult.success(value),
  );
  pages.set(key, atom);
  return atom;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { isNativeHost: () => true, openNativeTool },
  });
  boundary.navigate.mockClear();
  boundary.refresh.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  openNativeTool.mockClear();
  boundary.requests = [];
  boundary.stale = false;
  pages.clear();
  registry = AtomRegistry.make();
  registry.set(catalog, AsyncResult.success(view));
  setPage("alpha:0", scoped(alpha, [laneA]));
  setPage("beta:0", scoped(beta, [laneB]));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  registry.dispose();
  container.remove();
  delete window.desktopBridge;
  vi.unstubAllGlobals();
});
it("opens sessions from each workspace without lane management", async () => {
  await render();
  const card = container.querySelector('section[aria-label="alpha"]')!;
  const link = [...card.querySelectorAll("a")].find((item) =>
    item.textContent?.includes("Open sessions"),
  )!;
  expect(link).toBeDefined();
  await act(async () => link.click());
  expect(boundary.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ workspace: "alpha", tab: "agents" }),
  );
  expect(container.querySelector('[aria-label="Expand lanes for alpha"]')).toBeNull();
});
it("disables workspace editing while native state is stale", async () => {
  await render();
  boundary.stale = true;
  await act(async () => registry.set(catalog, AsyncResult.success({ ...view })));
  expect(button("Workspace settings for alpha").disabled).toBe(true);
  await click("Workspace settings for alpha");
  expect(openNativeTool).not.toHaveBeenCalled();
});
it("keeps workspace pagination separate from lane pages", async () => {
  registry.set(catalog, AsyncResult.success({ ...view, total: 21, nextOffset: 20 }));
  await render();
  await click("Next workspaces");
  expect(boundary.requests.at(-1)).toMatchObject({ offset: 20, workspacesOnly: true });
  await click("Previous workspaces");
  expect(boundary.requests.at(-1)).toMatchObject({ offset: 0, workspacesOnly: true });
});

it("refreshes the selected computer from settings and shows pending feedback", async () => {
  let finish!: (value: { _tag: string }) => void;
  boundary.refresh.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await click("Refresh workspaces");
  expect(boundary.refresh).toHaveBeenCalledWith({ environmentId: "computer", input: {} });
  expect(button("Refresh workspaces").disabled).toBe(true);
  expect(button("Refresh workspaces").getAttribute("aria-busy")).toBe("true");
  expect(container.textContent).toContain("Refreshing…");
  await act(async () => {
    finish({ _tag: "Success" });
  });
});
