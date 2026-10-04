import type { EnvironmentId, PullRequestListInput, PullRequestRef } from "@t3tools/contracts";
import type {
  ContextPullRequest,
  ContextPullRequestsPage,
  IntegrationView,
} from "@t3tools/contracts/deckhand/rpc";
import type { WorkspaceSearch } from "./workspaceNavigation";
import { overviewResources } from "./workspaceNavigation";
export type ConnectedPullRequestSearch = {
  environmentId: EnvironmentId;
  involvement: "all";
  state: "all";
  deckhandWorkspace: string;
  deckhandContext: string;
  deckhandInstallationID: string;
  deckhandGeneration: number;
  deckhandTab?: "agents" | "overview";
  deckhandOffset?: number;
  selectedHost?: string;
  repository?: string;
  number?: number;
};
export function connectedPullRequestSearch(
  environmentId: EnvironmentId,
  context: { workspaceID: string; contextID: string; installationID: string; generation: number },
  tab: "agents" | "overview" = "overview",
): ConnectedPullRequestSearch {
  return {
    environmentId,
    involvement: "all",
    state: "all",
    deckhandWorkspace: context.workspaceID,
    deckhandContext: context.contextID,
    deckhandInstallationID: context.installationID,
    deckhandGeneration: context.generation,
    deckhandTab: tab,
  };
}
export function validateConnectedPullRequestSearch(
  raw: Record<string, unknown>,
): Partial<ConnectedPullRequestSearch> {
  if (!Object.keys(raw).some((key) => key.startsWith("deckhand"))) return {};
  for (const key of [
    "environmentId",
    "deckhandWorkspace",
    "deckhandContext",
    "deckhandInstallationID",
  ]) {
    if (typeof raw[key] !== "string" || !raw[key].trim() || raw[key].length > 160)
      throw new Error("This pull request link is missing its saved workspace context.");
  }
  const generation =
    typeof raw.deckhandGeneration === "string" && /^[1-9]\d*$/.test(raw.deckhandGeneration)
      ? Number(raw.deckhandGeneration)
      : raw.deckhandGeneration;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1)
    throw new Error("This pull request link has an invalid saved generation.");
  if (
    raw.deckhandTab !== undefined &&
    raw.deckhandTab !== "agents" &&
    raw.deckhandTab !== "overview"
  )
    throw new Error("This pull request link has an invalid return view.");
  const offset =
    raw.deckhandOffset === undefined
      ? 0
      : typeof raw.deckhandOffset === "number"
        ? raw.deckhandOffset
        : typeof raw.deckhandOffset === "string" && /^(0|[1-9]\d*)$/.test(raw.deckhandOffset)
          ? Number(raw.deckhandOffset)
          : NaN;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("This pull request link has an invalid saved page.");
  const selection = [raw.selectedHost, raw.repository, raw.number];
  const hasSelection = selection.some((value) => value !== undefined);
  const number =
    typeof raw.number === "number"
      ? raw.number
      : typeof raw.number === "string" && /^[1-9]\d*$/.test(raw.number)
        ? Number(raw.number)
        : NaN;
  if (
    hasSelection &&
    (typeof raw.selectedHost !== "string" ||
      !raw.selectedHost.trim() ||
      raw.selectedHost.length > 253 ||
      typeof raw.repository !== "string" ||
      !raw.repository.trim() ||
      raw.repository.length > 1000 ||
      !Number.isSafeInteger(number) ||
      number < 1)
  )
    throw new Error("This pull request link has an invalid saved selection.");
  return {
    ...connectedPullRequestSearch(
      raw.environmentId as EnvironmentId,
      {
        workspaceID: raw.deckhandWorkspace as string,
        contextID: raw.deckhandContext as string,
        installationID: raw.deckhandInstallationID as string,
        generation,
      },
      raw.deckhandTab === "agents" ? "agents" : "overview",
    ),
    ...(offset ? { deckhandOffset: offset } : {}),
    ...(hasSelection
      ? { selectedHost: raw.selectedHost as string, repository: raw.repository as string, number }
      : {}),
  };
}
export function contextPullRequestNavigation(
  scope: ConnectedPullRequestSearch,
  offset: number,
  item?: ContextPullRequest,
): ConnectedPullRequestSearch {
  return {
    ...connectedPullRequestSearch(
      scope.environmentId,
      {
        workspaceID: scope.deckhandWorkspace,
        contextID: scope.deckhandContext,
        installationID: scope.deckhandInstallationID,
        generation: scope.deckhandGeneration,
      },
      scope.deckhandTab,
    ),
    ...(offset ? { deckhandOffset: offset } : {}),
    ...(item
      ? { selectedHost: item.link.host, repository: item.link.repository, number: item.link.number }
      : {}),
  };
}
export function contextPullRequestSelection(
  scope: ConnectedPullRequestSearch,
  items: ReadonlyArray<ContextPullRequest>,
): ContextPullRequest | null {
  if (!scope.selectedHost || !scope.repository || scope.number === undefined) return null;
  const key = contextPullRequestKey({
    host: scope.selectedHost,
    repository: scope.repository,
    number: scope.number,
  });
  return items.find((item) => contextPullRequestKey(item.link) === key) ?? null;
}
export function contextPullRequestReturn(scope: ConnectedPullRequestSearch): WorkspaceSearch {
  return {
    environment: scope.environmentId,
    workspace: scope.deckhandWorkspace,
    context: scope.deckhandContext,
    expectedInstallationID: scope.deckhandInstallationID,
    expectedGeneration: scope.deckhandGeneration,
    tab: scope.deckhandTab ?? "overview",
  };
}
export function contextPullRequestState(
  scope: ConnectedPullRequestSearch,
  view: IntegrationView | null,
  page: ContextPullRequestsPage | null,
  failed: boolean,
): "loading" | "unavailable" | "changed" | "ready" {
  if (!view) return failed ? "unavailable" : "loading";
  if (view.state !== "connected") return "unavailable";
  const resource = overviewResources(view).find(
    (item) => item.workspaceID === scope.deckhandContext,
  );
  if (
    view.hello?.installationID !== scope.deckhandInstallationID ||
    !resource?.available ||
    resource.generation !== scope.deckhandGeneration ||
    !resource.workspace ||
    resource.workspace.definitionChanged ||
    resource.workspace.issues.length ||
    (resource.workspace.lane?.sourceStackID ?? resource.workspaceID) !== scope.deckhandWorkspace
  )
    return "changed";
  if (failed) return "unavailable";
  if (!page) return "loading";
  return page.installationID === scope.deckhandInstallationID &&
    page.workspaceID === scope.deckhandContext &&
    page.generation === scope.deckhandGeneration
    ? "ready"
    : "changed";
}
export function contextPullRequestKey(
  link: Pick<ContextPullRequest["link"], "host" | "repository" | "number">,
): string {
  return JSON.stringify([link.host.toLowerCase(), link.repository.toLowerCase(), link.number]);
}
export function contextPullRequestTargets(
  environmentId: EnvironmentId,
  items: ReadonlyArray<ContextPullRequest>,
) {
  const projectIds = [...new Set(items.map((item) => item.projectId))].sort();
  return projectIds.length
    ? [
        {
          environmentId,
          input: { projectIds, state: "all", limit: 50 } satisfies PullRequestListInput,
        },
      ]
    : [];
}
export function contextPullRequestReference(item: ContextPullRequest): PullRequestRef {
  return {
    projectId: item.projectId,
    host: item.link.host,
    repository: item.link.repository,
    number: item.link.number,
  };
}
