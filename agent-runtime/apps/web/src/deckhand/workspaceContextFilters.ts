import type { IntegrationView, ManagedContextView } from "@cinderdeck/contracts/deckhand/rpc";

export type WorkspaceResource = IntegrationView["resources"][number];
export type WorkspaceFilterValue = {
  search: string;
  activity: "all" | "active" | "attention" | "quiet" | "history";
  lifecycle: "all" | "available" | "unavailable" | `state:${string}`;
  provider: string;
  sort: "loaded" | "name" | "activity";
};
export const defaultWorkspaceFilters: WorkspaceFilterValue = {
  search: "",
  activity: "all",
  lifecycle: "all",
  provider: "all",
  sort: "loaded",
};
export type WorkspaceFilterOptions = {
  nativeUnavailable: boolean;
  agentsUnavailable: boolean;
  providers?: ReadonlyArray<{ instanceId: string; displayName: string }>;
  activity?: IntegrationView["activity"] | undefined;
};
type Match = "yes" | "no" | "unknown";
const activeExecutions = new Set([
  "queued",
  "starting",
  "working",
  "waiting_input",
  "waiting_approval",
]);
const attentionExecutions = new Set(["waiting_input", "waiting_approval", "failed"]);
const contextName = (resource: WorkspaceResource) =>
  resource.workspace?.lane?.name ?? resource.workspace?.name ?? resource.workspaceID;
const incomplete = (summary: ManagedContextView | undefined) =>
  !summary || summary.total > summary.sessions.length;
const combine = (matches: ReadonlyArray<Match>): Match =>
  matches.includes("no") ? "no" : matches.includes("unknown") ? "unknown" : "yes";

function activityMatch(
  resource: WorkspaceResource,
  summary: ManagedContextView | undefined,
  activity: WorkspaceFilterValue["activity"],
  options: WorkspaceFilterOptions,
): Match {
  if (activity === "all") return "yes";
  if (activity === "history") {
    if (summary?.sessions.some((session) => session.archived)) return "yes";
    return incomplete(summary) ? "unknown" : "no";
  }
  const sessions = summary?.sessions.filter((session) => !session.archived) ?? [];
  const statesUnknown =
    options.agentsUnavailable ||
    incomplete(summary) ||
    !!(
      summary?.externalSessions &&
      (summary.externalSessions.unavailable || summary.externalSessions.activeCount > 0)
    ) ||
    sessions.some(
      (session) =>
        session.source === "unavailable" ||
        session.binding.connection !== "connected" ||
        session.binding.execution === "unknown",
    );
  const active =
    !options.agentsUnavailable &&
    sessions.some(
      (session) =>
        session.source === "current" &&
        session.binding.connection === "connected" &&
        activeExecutions.has(session.binding.execution),
    );
  if (activity === "active") return active ? "yes" : statesUnknown ? "unknown" : "no";
  const nativeUnknown = options.nativeUnavailable || !resource.workspace;
  const attention =
    (!options.nativeUnavailable &&
      (!resource.available ||
        !!resource.workspace?.definitionChanged ||
        !!resource.workspace?.issues.length ||
        !!resource.workspace?.services.some((service) =>
          ["failed", "error"].includes(service.phase),
        ))) ||
    (!options.agentsUnavailable &&
      sessions.some(
        (session) =>
          session.source === "unavailable" || attentionExecutions.has(session.binding.execution),
      ));
  if (activity === "attention")
    return attention ? "yes" : statesUnknown || nativeUnknown ? "unknown" : "no";
  // Quiet requires a complete, current summary; a four-row sample is not proof of inactivity.
  const servicesActive = resource.workspace?.services.some(
    (service) =>
      service.ready || ["running", "starting", "stopping", "waiting"].includes(service.phase),
  );
  if (active || attention || servicesActive) return "no";
  return statesUnknown || nativeUnknown ? "unknown" : "yes";
}

/** Filters only the supplied catalog page and bounded summaries. Unprovable exclusions stay visible. */
export function selectWorkspaceContexts(
  resources: ReadonlyArray<WorkspaceResource>,
  summaries: ReadonlyArray<ManagedContextView> | null,
  value: WorkspaceFilterValue,
  options: WorkspaceFilterOptions,
) {
  const summaryByContext = new Map(
    summaries?.map((summary) => [`${summary.workspaceID}:${summary.generation}`, summary]),
  );
  const providerNames = new Map(
    options.providers?.map((provider) => [provider.instanceId, provider.displayName]),
  );
  const words = value.search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  let matchedCount = 0;
  let uncertainCount = 0;
  const visible = resources.filter((resource) => {
    const summary = summaryByContext.get(`${resource.workspaceID}:${resource.generation}`);
    const native = resource.workspace;
    let lifecycle: Match = "yes";
    if (value.lifecycle !== "all") {
      if (options.nativeUnavailable) lifecycle = "unknown";
      else if (value.lifecycle === "available") lifecycle = resource.available ? "yes" : "no";
      else if (value.lifecycle === "unavailable") lifecycle = resource.available ? "no" : "yes";
      else
        lifecycle = !native ? "unknown" : native.state === value.lifecycle.slice(6) ? "yes" : "no";
    }
    const provider: Match =
      value.provider === "all" ||
      summary?.sessions.some((session) => session.binding.providerInstanceId === value.provider)
        ? "yes"
        : options.agentsUnavailable || incomplete(summary)
          ? "unknown"
          : "no";
    const searchable = [
      resource.workspaceID,
      contextName(resource),
      native?.name,
      native?.state,
      ...(native?.repos.flatMap((repo) => [repo.id, repo.branch]) ?? []),
      ...(native?.services.map((service) => service.name) ?? []),
      ...(summary?.sessions.flatMap((session) => [
        session.title,
        session.objective ?? "",
        session.binding.providerInstanceId,
        providerNames.get(session.binding.providerInstanceId) ?? "",
      ]) ?? []),
    ]
      .join(" ")
      .toLocaleLowerCase();
    const search: Match =
      !words.length || words.every((word) => searchable.includes(word))
        ? "yes"
        : options.agentsUnavailable || options.nativeUnavailable || incomplete(summary) || !native
          ? "unknown"
          : "no";
    const match = combine([
      lifecycle,
      provider,
      search,
      activityMatch(resource, summary, value.activity, options),
    ]);
    if (match === "no") return false;
    if (match === "unknown") uncertainCount++;
    else matchedCount++;
    return true;
  });
  if (value.sort === "name")
    visible.sort((left, right) => contextName(left).localeCompare(contextName(right)));
  else if (value.sort === "activity") {
    const lastObserved = new Map<string, number>();
    for (const event of options.activity ?? []) {
      const timestamp = Date.parse(event.observedAt ?? event.occurredAt ?? "");
      if (Number.isFinite(timestamp)) {
        const key = `${event.workspaceID}:${event.generation}`;
        lastObserved.set(key, Math.max(lastObserved.get(key) ?? 0, timestamp));
      }
    }
    visible.sort(
      (left, right) =>
        (lastObserved.get(`${right.workspaceID}:${right.generation}`) ?? 0) -
        (lastObserved.get(`${left.workspaceID}:${left.generation}`) ?? 0),
    );
  }
  return { resources: visible, matchedCount, uncertainCount, loadedCount: resources.length };
}
