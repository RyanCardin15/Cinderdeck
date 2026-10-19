import { describe, expect, it } from "vite-plus/test";
import {
  relativeWorkspaceFilePath,
  resolveWorkspaceTreePath,
  workspaceFilePreviewTarget,
  workspaceFileRoots,
  workspaceRootEntries,
  workspaceTreePath,
} from "./workspaceFileRoots";

const workspace = {
  id: "demo",
  name: "Demo",
  file: "/config/demo.toml",
  state: "idle",
  definitionChanged: false,
  issues: [],
  services: [],
  root: "/projects",
  repos: [
    {
      id: "web",
      path: "/projects/web",
      physicalID: "web-git",
      branch: "main",
      dirty: false,
      changedFiles: 0,
      ahead: 0,
      behind: 0,
    },
    {
      id: "api",
      path: "/elsewhere/api",
      physicalID: "api-git",
      branch: "main",
      dirty: false,
      changedFiles: 0,
      ahead: 0,
      behind: 0,
    },
    {
      id: "design",
      path: "/documents/design",
      branch: "",
      dirty: false,
      changedFiles: 0,
      ahead: 0,
      behind: 0,
    },
  ],
  files: ["/briefs/brief.md", "/other/brief.md"],
};
const context = {
  native: { workspaceID: "demo", generation: 1, available: true, revision: "1", workspace },
};

describe("session workspace files", () => {
  it.each([
    ["/tmp", "/private/tmp"],
    ["/private/tmp", "/tmp"],
    ["/var", "/private/var"],
  ])("does not duplicate Foundation and Node spellings of %s", (nativeRoot, sessionRoot) => {
    const roots = workspaceFileRoots(
      {
        native: {
          ...context.native,
          workspace: {
            ...workspace,
            repos: [{ ...workspace.repos[0]!, path: `${nativeRoot}/fixture/client` }],
            files: [],
          },
        },
      },
      `${sessionRoot}/fixture/client`,
      "Client",
    );
    expect(roots).toHaveLength(1);
    expect(
      workspaceFilePreviewTarget(roots, `${sessionRoot}/fixture/client`, "Docs/README.md"),
    ).toMatchObject({
      cwd: `${nativeRoot}/fixture/client`,
      relativePath: "Docs/README.md",
      treePath: "Repositories/web/Docs/README.md",
    });
  });
  it("includes every configured repository, plain folder and added file, without browsing their common parent", () => {
    const roots = workspaceFileRoots(context, "/projects/web", "web");
    expect(roots.map((root) => root.path)).toEqual([
      "/projects/web",
      "/elsewhere/api",
      "/documents/design",
      "/briefs/brief.md",
      "/other/brief.md",
    ]);
    expect(workspaceRootEntries(roots)).toEqual(
      expect.arrayContaining([
        { path: "Repositories/web", kind: "directory" },
        { path: "Repositories/api", kind: "directory" },
        { path: "Folders/design", kind: "directory" },
        { path: "Added files/brief.md", kind: "file" },
        { path: "Added files/brief.md (2)", kind: "file" },
      ]),
    );
  });

  it("keeps identically named files in different folders distinct through opening and preview", () => {
    const roots = workspaceFileRoots(context, "/projects/web", "web");
    for (const [treePath, cwd] of [
      ["Repositories/web", "/projects/web"],
      ["Repositories/api", "/elsewhere/api"],
    ]) {
      const opened = resolveWorkspaceTreePath(roots, `${treePath}/src/index.ts`)!;
      expect(opened.absolutePath).toBe(`${cwd}/src/index.ts`);
      expect(workspaceFilePreviewTarget(roots, "/projects/web", opened.absolutePath)).toMatchObject(
        {
          cwd,
          relativePath: "src/index.ts",
          treePath: `${treePath}/src/index.ts`,
        },
      );
    }
  });

  it("resolves mentions and previews of added files to the exact file without including its siblings", () => {
    const roots = workspaceFileRoots(context, "/projects/web", "web");
    const added = resolveWorkspaceTreePath(roots, "Added files/brief.md (2)")!;
    expect(added.absolutePath).toBe("/other/brief.md");
    expect(workspaceFilePreviewTarget(roots, "/projects/web", added.absolutePath)).toMatchObject({
      cwd: "/projects/web",
      relativePath: "/other/brief.md",
      treePath: "Added files/brief.md (2)",
    });
    expect(workspaceTreePath(roots, "/other/unrelated.md")).toBeNull();
    expect(resolveWorkspaceTreePath(roots, "Repositories")).toBeNull();
  });

  it("retains a session's independent worktree alongside the workspace folders", () => {
    const roots = workspaceFileRoots(context, "/worktrees/review/web", "web");
    expect(roots.at(-1)).toEqual({
      path: "/worktrees/review/web",
      treePath: "Session checkout/web",
      kind: "directory",
    });
    expect(workspaceFilePreviewTarget(roots, "/worktrees/review/web", "README.md")).toMatchObject({
      cwd: "/worktrees/review/web",
      relativePath: "README.md",
      treePath: "Session checkout/web/README.md",
    });
  });

  it("deduplicates configured paths and selects the most specific nested root", () => {
    const roots = workspaceFileRoots(
      {
        native: {
          ...context.native,
          workspace: {
            ...workspace,
            repos: [
              ...workspace.repos,
              { ...workspace.repos[0]!, id: "duplicate", path: "/projects/web/" },
              { ...workspace.repos[2]!, id: "nested", path: "/projects/web/docs" },
            ],
            files: ["/projects/web/docs/guide.md"],
          },
        },
      },
      "/projects/web",
      "web",
    );
    expect(roots.some((root) => root.treePath.includes("duplicate"))).toBe(false);
    expect(workspaceTreePath(roots, "/projects/web/docs/index.md")).toBe("Folders/nested/index.md");
    expect(workspaceTreePath(roots, "/projects/web/docs/guide.md")).toBe("Added files/guide.md");
    expect(workspaceTreePath(roots, "/projects/web-other/test.md")).toBeNull();
  });

  it("provides a normal project fallback, handles filesystem roots and remote Windows paths", () => {
    expect(workspaceFileRoots(null, "/project", "Project")).toEqual([
      { path: "/project", treePath: "Folders/Project", kind: "directory" },
    ]);
    expect(relativeWorkspaceFilePath("/file.txt", "/")).toBe("file.txt");
    const roots = workspaceFileRoots(null, "C:\\Projects\\App", "App");
    expect(workspaceTreePath(roots, "c:/projects/app/src/main.ts")).toBe("Folders/App/src/main.ts");
    expect(resolveWorkspaceTreePath(roots, "Folders/App/src/main.ts")?.absolutePath).toBe(
      "C:\\Projects\\App\\src\\main.ts",
    );
  });
});
