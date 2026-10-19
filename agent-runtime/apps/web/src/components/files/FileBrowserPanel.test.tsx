import { EnvironmentId } from "@cinderdeck/contracts";
import type { FileTree as FileTreeModel } from "@pierre/trees";
import { FileTree } from "@pierre/trees/react";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { query, mutations } = vi.hoisted(() => ({
  query: vi.fn(),
  mutations: { refresh: () => {} },
}));
vi.mock("@cinderdeck/client-runtime/state/runtime", () => ({ executeAtomQuery: query }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("~/state/projects", () => ({
  projectEnvironment: {
    listEntries: (target: unknown) => ({ operation: "list", ...(target as object) }),
    searchEntries: (target: unknown) => ({ operation: "search", ...(target as object) }),
  },
}));
vi.mock("~/state/queries", () => ({ useDebouncedValue: (value: unknown) => value }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({
  useWorkspaceMutationRefresh: (options: { refresh: () => void }) => {
    mutations.refresh = options.refresh;
  },
}));
vi.mock("~/fileContextMenu", () => ({ useFileContextMenu: () => ({ buildItems: () => [] }) }));
vi.mock("~/localApi", () => ({ readLocalApi: () => null }));
vi.mock("~/hooks/useCopyToClipboard", () => ({ writeTextToClipboard: vi.fn() }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

import FileBrowserPanel from "./FileBrowserPanel";
import type { WorkspaceFileRoot } from "./workspaceFileRoots";

const roots: WorkspaceFileRoot[] = [
  { path: "/fixture/web", treePath: "Repositories/web", kind: "directory" },
  { path: "/fixture/api", treePath: "Repositories/api", kind: "directory" },
  { path: "/fixture/design", treePath: "Folders/design", kind: "directory" },
  { path: "/briefs/brief.md", treePath: "Added files/brief.md", kind: "file" },
];
const environmentId = EnvironmentId.make("workspace-files-test");
const open = vi.fn();
const props = {
  environmentId,
  cwd: "/fixture/web",
  projectName: "Demo workspace",
  roots,
  selectedPath: null as string | null,
  selectedPathRevealId: 0,
  onOpenFile: open,
  workspaceMutationId: null,
};
let renderer: ReactTestRenderer | undefined;
const model = (): FileTreeModel => renderer!.root.findByType(FileTree).props.model;
const listCalls = () =>
  query.mock.calls.map((call) => call[1]).filter((call) => call.operation === "list");
async function mount() {
  await act(async () => {
    renderer = create(<FileBrowserPanel {...props} />);
  });
}
async function expand(path: string) {
  await act(async () => {
    const item = model().getItem(`${path}/`)!;
    if ("expand" in item) item.expand();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  open.mockReset();
  query.mockReset().mockImplementation(async (_registry, request) => {
    if (request.operation === "search")
      return AsyncResult.success({
        entries: [{ path: "nested/target.md", kind: "file" }],
        truncated: false,
      });
    return AsyncResult.success({
      entries:
        request.input.directoryPath === "nested"
          ? [{ path: "nested/target.md", kind: "file" }]
          : [
              { path: "README.md", kind: "file" },
              { path: "nested", kind: "directory" },
              { path: ".env", kind: "file", ignored: true },
            ],
      truncated: false,
    });
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("workspace file browser", () => {
  it("shows all roots immediately and only reads the folder being expanded", async () => {
    await mount();
    for (const root of roots)
      expect(model().getItem(root.treePath + (root.kind === "directory" ? "/" : ""))).toBeDefined();
    expect(listCalls()).toHaveLength(0);
    await expand("Repositories/api");
    expect(listCalls().map((call) => call.input)).toEqual([
      { cwd: "/fixture/api", directoryPath: "" },
    ]);
    expect(model().getItem("Repositories/api/README.md")).toBeDefined();
    expect(model().getItem("Repositories/api/.env")).toBeDefined();
    await act(async () => {
      model().getItem("Repositories/api/README.md")!.select();
    });
    expect(open).toHaveBeenLastCalledWith("/fixture/api/README.md");
    await act(async () => {
      model().getItem("Added files/brief.md")!.select();
    });
    expect(open).toHaveBeenLastCalledWith("/briefs/brief.md");
    expect(listCalls()).toHaveLength(1);
  });

  it("reveals a file from another root and refreshes loaded folders without losing expansion", async () => {
    await mount();
    await act(async () => {
      renderer!.update(
        <FileBrowserPanel
          {...props}
          selectedPath="Folders/design/nested/target.md"
          selectedPathRevealId={1}
        />,
      );
    });
    expect(listCalls().map((call) => call.input)).toEqual(
      expect.arrayContaining([
        { cwd: "/fixture/design", directoryPath: "" },
        { cwd: "/fixture/design", directoryPath: "nested" },
      ]),
    );
    expect(model().getSelectedPaths()).toEqual(["Folders/design/nested/target.md"]);
    expect(open).not.toHaveBeenCalled();
    const before = listCalls().length;
    await act(async () => mutations.refresh());
    expect(listCalls().length).toBeGreaterThan(before);
    const item = model().getItem("Folders/design/nested/")!;
    expect("isExpanded" in item && item.isExpanded()).toBe(true);
  });

  it("searches unopened folders and retains the root of every match", async () => {
    await mount();
    await act(async () =>
      renderer!.root
        .findByProps({ name: "project-files-search", type: "search" })
        .props.onChange({ target: { value: "target" } }),
    );
    const searches = query.mock.calls
      .map((call) => call[1])
      .filter((call) => call.operation === "search");
    expect(searches.map((call) => call.input.cwd).sort()).toEqual([
      "/fixture/api",
      "/fixture/design",
      "/fixture/web",
    ]);
    for (const root of roots.filter((root) => root.kind === "directory"))
      expect(model().getItem(`${root.treePath}/nested/target.md`)).toBeDefined();
    expect(listCalls()).toHaveLength(0);
  });

  it("reports a failed folder by its path and retries without hiding the other roots", async () => {
    query.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Folder unavailable"))));
    await mount();
    await expand("Repositories/api");
    expect(JSON.stringify(renderer!.toJSON())).toContain("/fixture/api: Folder unavailable");
    expect(model().getItem("Folders/design/")).toBeDefined();
    await act(async () => mutations.refresh());
    expect(model().getItem("Repositories/api/README.md")).toBeDefined();
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("Folder unavailable");
  });
});
