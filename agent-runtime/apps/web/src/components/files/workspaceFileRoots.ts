import type { ProjectEntry } from "@cinderdeck/contracts";
import type { ThreadContextView } from "@cinderdeck/contracts/deckhand/rpc";
import {
  isWindowsAbsolutePath,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
} from "@cinderdeck/shared/path";

export interface WorkspaceFileRoot {
  readonly path: string;
  readonly treePath: string;
  readonly kind: "directory" | "file";
}

// Foundation shortens macOS system symlinks while Node returns their real paths.
// Keep display paths intact, but compare both spellings as the same location.
const comparisonPath = (path: string) =>
  normalizeProjectPathForDispatch(path).replace(/^\/(tmp|var|etc)(?=\/|$)/, "/private/$1");
const normalize = (path: string) => normalizeProjectPathForComparison(comparisonPath(path));
const basename = (path: string) =>
  path
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) || path;
export function joinWorkspaceFilePath(root: string, path: string): string {
  if (!path) return root;
  const separator = isWindowsAbsolutePath(root) ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${path.replaceAll("/", separator)}`;
}

export function relativeWorkspaceFilePath(path: string, root: string): string | null {
  const target = normalize(path);
  const base = normalize(root);
  if (target === base) return "";
  const separator = isWindowsAbsolutePath(root) ? "\\" : "/";
  const prefix = base.endsWith(separator) ? base : `${base}${separator}`;
  const displayPath = isWindowsAbsolutePath(path)
    ? comparisonPath(path).replaceAll("/", "\\")
    : comparisonPath(path);
  return target.startsWith(prefix)
    ? displayPath.slice(prefix.length).replaceAll(separator, "/")
    : null;
}

/** The native catalog contains plain folders as well as Git repositories. */
export function workspaceFileRoots(
  context:
    | {
        readonly native?: ThreadContextView["native"];
        readonly checkout?: Pick<ThreadContextView["checkout"], "repositories">;
      }
    | null
    | undefined,
  cwd: string,
  projectName: string,
): readonly WorkspaceFileRoot[] {
  const workspace = context?.native?.workspace;
  const roots: WorkspaceFileRoot[] = [];
  const seen = new Set<string>();
  const labels = new Set<string>();
  const add = (path: string, group: string, label: string, kind: WorkspaceFileRoot["kind"]) => {
    if (!path || seen.has(normalize(path))) return;
    seen.add(normalize(path));
    const name = label.replace(/[\\/]/g, " · ") || basename(path);
    let treePath = `${group}/${name}`;
    for (let index = 2; labels.has(treePath); index++) treePath = `${group}/${name} (${index})`;
    labels.add(treePath);
    roots.push({ path, treePath, kind });
  };
  if (workspace) {
    for (const repo of workspace.repos) {
      add(repo.path, repo.physicalID ? "Repositories" : "Folders", repo.id, "directory");
    }
    if (!workspace.repos.length && workspace.root) {
      add(workspace.root, "Folders", basename(workspace.root), "directory");
    }
    for (const file of workspace.files ?? []) add(file, "Added files", basename(file), "file");
  } else {
    for (const repo of context?.checkout?.repositories ?? []) {
      add(repo.root, "Repositories", basename(repo.root), "directory");
    }
  }
  // Ordinary worktree handoffs can place the session outside the native workspace roots.
  if (
    cwd &&
    !roots.some(
      (root) => root.kind === "directory" && relativeWorkspaceFilePath(cwd, root.path) !== null,
    )
  ) {
    add(
      cwd,
      roots.length ? "Session checkout" : "Folders",
      projectName || basename(cwd),
      "directory",
    );
  }
  return roots;
}

/** Resolve a preview against its owning folder, rather than the session's first folder. */
export function workspaceFilePreviewTarget(
  roots: readonly WorkspaceFileRoot[],
  cwd: string,
  path: string | null,
) {
  const absolutePath =
    path === null
      ? null
      : path.startsWith("/") || isWindowsAbsolutePath(path)
        ? path
        : joinWorkspaceFilePath(cwd, path);
  const treePath = absolutePath ? workspaceTreePath(roots, absolutePath) : null;
  const root = treePath ? resolveWorkspaceTreePath(roots, treePath)?.root : null;
  const previewCwd = root?.kind === "directory" ? root.path : cwd;
  return {
    absolutePath,
    treePath,
    root,
    cwd: previewCwd,
    relativePath:
      absolutePath && root?.kind === "directory"
        ? relativeWorkspaceFilePath(absolutePath, previewCwd) || null
        : root?.kind === "file"
          ? absolutePath
          : path,
  };
}

export function workspaceRootEntries(roots: readonly WorkspaceFileRoot[]): ProjectEntry[] {
  const groups = [...new Set(roots.map((root) => root.treePath.split("/")[0]!))];
  return [
    ...groups.map((path) => ({ path, kind: "directory" as const })),
    ...roots.map((root) => ({ path: root.treePath, kind: root.kind })),
  ];
}

export function resolveWorkspaceTreePath(roots: readonly WorkspaceFileRoot[], path: string) {
  const root = roots.find((root) => path === root.treePath || path.startsWith(`${root.treePath}/`));
  if (!root) return null;
  const relativePath = path.slice(root.treePath.length).replace(/^\//, "");
  return { root, relativePath, absolutePath: joinWorkspaceFilePath(root.path, relativePath) };
}

export function workspaceTreePath(
  roots: readonly WorkspaceFileRoot[],
  absolutePath: string,
): string | null {
  // The most specific root wins when a folder or added file is also inside another root.
  const candidates = roots
    .flatMap((root) => {
      const relativePath = relativeWorkspaceFilePath(absolutePath, root.path);
      return relativePath === null || (root.kind === "file" && relativePath !== "")
        ? []
        : [{ root, relativePath }];
    })
    .sort((a, b) => b.root.path.length - a.root.path.length);
  const match = candidates[0];
  return match
    ? `${match.root.treePath}${match.relativePath ? `/${match.relativePath}` : ""}`
    : null;
}
