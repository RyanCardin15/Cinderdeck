import type { EnvironmentId } from "@cinderdeck/contracts";
import type { IntegrationView, ThreadContextView } from "@cinderdeck/contracts/deckhand/rpc";
export type WorkspaceSearch = {
  workspace?: string;
  context?: string;
  environment?: string;
  tab?:
    | "agents"
    | "overview"
    | "lane-map"
    | "services"
    | "tasks"
    | "workflows"
    | "runs"
    | "pull-requests"
    | "recordings";
  recording?: string;
  run?: string;
  prHost?: string;
  prRepository?: string;
  prNumber?: number;
  prOffset?: number;
  expectedGeneration?: number;
  expectedInstallationID?: string;
  editReviewSkill?: boolean;
};
// A conversation belongs to its execution environment, even when the viewer's
// primary computer differs. Saved native pins refuse a replaced lane/install.
export function connectedWorkspaceSearch(
  environmentId: EnvironmentId,
  context: {
    workspace: Pick<ThreadContextView["workspace"], "ownerId" | "environmentId">;
    checkout: Pick<ThreadContextView["checkout"], "laneId" | "nativeGeneration">;
  },
  tab?: WorkspaceSearch["tab"],
): WorkspaceSearch {
  return {
    environment: environmentId,
    ...(tab === undefined ? {} : { tab }),
    workspace: context.workspace.ownerId,
    context: context.checkout.laneId ?? context.workspace.ownerId,
    expectedInstallationID: context.workspace.environmentId,
    ...(context.checkout.nativeGeneration === undefined
      ? {}
      : { expectedGeneration: context.checkout.nativeGeneration }),
  };
}
export function validateWorkspaceSearch(value: Record<string, unknown>): WorkspaceSearch {
  const search: WorkspaceSearch = {};
  if (value.editReviewSkill === true || value.editReviewSkill === "true")
    search.editReviewSkill = true;
  if (value.tab !== undefined) {
    if (
      ![
        "agents",
        "overview",
        "lane-map",
        "services",
        "tasks",
        "workflows",
        "runs",
        "pull-requests",
        "recordings",
      ].includes(value.tab as string)
    )
      throw new Error("This workspace link has an invalid view.");
    search.tab = value.tab as NonNullable<WorkspaceSearch["tab"]>;
  }
  for (const key of ["environment", "workspace", "context", "recording", "run"] as const) {
    if (typeof value[key] === "string" && value[key].length <= 160) search[key] = value[key];
  }
  for (const key of ["prOffset", "prNumber"] as const) {
    if (value[key] === undefined) continue;
    const raw = value[key];
    const number = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number < (key === "prOffset" ? 0 : 1)
    )
      throw new Error("This workspace link has an invalid pull request selection.");
    search[key] = number;
  }
  for (const key of ["prHost", "prRepository"] as const) {
    if (value[key] === undefined) continue;
    const raw = value[key];
    if (typeof raw !== "string" || !raw.trim() || raw.length > (key === "prHost" ? 253 : 1000))
      throw new Error("This workspace link has an invalid pull request selection.");
    search[key] = raw;
  }
  if (
    (search.prHost !== undefined ||
      search.prRepository !== undefined ||
      search.prNumber !== undefined) &&
    (!search.prHost || !search.prRepository || search.prNumber === undefined)
  )
    throw new Error("This workspace link is missing its pull request identity.");
  if (value.expectedGeneration !== undefined) {
    const raw = value.expectedGeneration;
    const generation = typeof raw === "string" && /^[1-9]\d*$/.test(raw) ? Number(raw) : raw;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) {
      throw new Error("This workspace link has an invalid saved generation.");
    }
    search.expectedGeneration = generation;
  }
  if (value.expectedInstallationID !== undefined) {
    const installation = value.expectedInstallationID;
    if (typeof installation !== "string" || !installation.trim() || installation.length > 160) {
      throw new Error("This workspace link has an invalid saved installation.");
    }
    search.expectedInstallationID = installation;
  }
  if (
    (search.expectedGeneration !== undefined || search.expectedInstallationID !== undefined) &&
    !search.workspace &&
    !search.context
  ) {
    throw new Error("This workspace link is missing its saved context.");
  }
  return search;
}
export function savedWorkspaceMatches(
  search: WorkspaceSearch,
  installation: string | undefined,
  generation: number | undefined,
): boolean {
  return (
    (search.expectedInstallationID === undefined ||
      search.expectedInstallationID === installation) &&
    (search.expectedGeneration === undefined || search.expectedGeneration === generation)
  );
}

// Selected details share the same catalog snapshot as the page. Reserve their two
// slots so the merged view still fits a single bounded summary request.
export function overviewPageSelection(
  search: WorkspaceSearch,
  offset: number,
  workspaceOffset = 0,
) {
  return {
    offset,
    limit: 48,
    workspacePage: { offset: workspaceOffset, limit: 50 },
    ...(search.workspace ? { selectedWorkspaceID: search.workspace } : {}),
    ...(search.context ? { selectedContextID: search.context } : {}),
  };
}
export function overviewResources(view: IntegrationView | null): IntegrationView["resources"] {
  if (!view) return [];
  const resources = [
    ...(view.selectedResources ?? []),
    ...(view.workspaceContexts?.resources ?? []),
    ...view.resources,
  ];
  const seen = new Set<string>();
  return resources.filter((resource) => {
    if (seen.has(resource.workspaceID)) return false;
    seen.add(resource.workspaceID);
    return true;
  });
}

// The scoped page is authoritative even when unrelated lanes share a catalog page.
// Keep explicit primary/lane pins visible when they fall outside that scoped page.
export function overviewWorkspaceContexts(
  view: IntegrationView | null,
  workspaceID: string,
): IntegrationView["resources"] {
  if (!view) return [];
  const belongs = (resource: IntegrationView["resources"][number]) =>
    resource.workspaceID === workspaceID || resource.workspace?.lane?.sourceStackID === workspaceID;
  if (view.workspaceContexts?.workspaceID === workspaceID) {
    return overviewResources({
      ...view,
      resources: [],
      selectedResources: (view.selectedResources ?? []).filter(belongs),
    }).filter(belongs);
  }
  return overviewResources(view).filter(belongs);
}
