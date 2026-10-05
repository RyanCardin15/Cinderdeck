import { useId } from "react";
import type { ManagedContextView } from "@cinderdeck/contracts/deckhand/rpc";
import {
  defaultWorkspaceFilters,
  selectWorkspaceContexts,
  type WorkspaceFilterOptions,
  type WorkspaceFilterValue,
  type WorkspaceResource,
} from "./workspaceContextFilters";
import styles from "./workspace.module.css";
import filterStyles from "./WorkspaceFilters.module.css";

export function WorkspaceFilters(
  props: WorkspaceFilterOptions & {
    value: WorkspaceFilterValue;
    onChange: (value: WorkspaceFilterValue) => void;
    resources: ReadonlyArray<WorkspaceResource>;
    summaries: ReadonlyArray<ManagedContextView> | null;
    loading?: boolean;
    totalContextCount?: number;
  },
) {
  const id = useId();
  const result = selectWorkspaceContexts(props.resources, props.summaries, props.value, props);
  const change = <K extends keyof WorkspaceFilterValue>(key: K, value: WorkspaceFilterValue[K]) =>
    props.onChange({ ...props.value, [key]: value });
  const states = [
    ...new Set(
      props.resources.flatMap((resource) =>
        resource.workspace?.state ? [resource.workspace.state] : [],
      ),
    ),
  ];
  const providers = new Map(
    props.providers?.map((provider) => [provider.instanceId, provider.displayName]),
  );
  for (const summary of props.summaries ?? []) {
    for (const session of summary.sessions) {
      if (!providers.has(session.binding.providerInstanceId))
        providers.set(session.binding.providerInstanceId, session.binding.providerInstanceId);
    }
  }
  if (props.value.provider !== "all" && !providers.has(props.value.provider))
    providers.set(props.value.provider, `${props.value.provider} · not loaded`);
  const savedState = props.value.lifecycle.startsWith("state:")
    ? props.value.lifecycle.slice(6)
    : null;
  if (savedState && !states.includes(savedState)) states.push(savedState);
  const filtering =
    props.value.search.trim() ||
    props.value.activity !== "all" ||
    props.value.lifecycle !== "all" ||
    props.value.provider !== "all";
  return (
    <section className={filterStyles.root} aria-label="Filter workspace contexts">
      <details className={filterStyles.fold}>
        <summary>
          Filters &amp; sort
          {filtering || props.value.sort !== "loaded" ? <span>Active</span> : null}
        </summary>
        <div className={`${styles["dh-toolbar"]} ${filterStyles.controls}`}>
          <label htmlFor={`${id}-search`}>
            Search
            <input
              id={`${id}-search`}
              type="search"
              maxLength={200}
              placeholder="Lane, branch or agent task"
              value={props.value.search}
              onChange={(event) => change("search", event.target.value)}
            />
          </label>
          <label htmlFor={`${id}-activity`}>
            Activity
            <select
              id={`${id}-activity`}
              value={props.value.activity}
              onChange={(event) =>
                change("activity", event.target.value as WorkspaceFilterValue["activity"])
              }
            >
              <option value="all">All activity</option>
              <option value="active">Active agents</option>
              <option value="attention">Needs attention</option>
              <option value="quiet">Quiet contexts</option>
              <option value="history">Historical contributors</option>
            </select>
          </label>
          <label htmlFor={`${id}-lifecycle`}>
            Lifecycle
            <select
              id={`${id}-lifecycle`}
              value={props.value.lifecycle}
              onChange={(event) =>
                change("lifecycle", event.target.value as WorkspaceFilterValue["lifecycle"])
              }
            >
              <option value="all">All lifecycle states</option>
              <option value="available">Available</option>
              <option value="unavailable">Unavailable</option>
              {states.map((state) => (
                <option key={state} value={`state:${state}`}>
                  State: {state.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={`${id}-provider`}>
            Provider
            <select
              id={`${id}-provider`}
              value={props.value.provider}
              onChange={(event) => change("provider", event.target.value)}
            >
              <option value="all">All providers</option>
              {[...providers].map(([instanceId, name]) => (
                <option key={instanceId} value={instanceId}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={`${id}-sort`}>
            Sort
            <select
              id={`${id}-sort`}
              value={props.value.sort}
              onChange={(event) =>
                change("sort", event.target.value as WorkspaceFilterValue["sort"])
              }
            >
              <option value="loaded">Page order</option>
              <option value="name">Name</option>
              <option value="activity">Latest observed activity</option>
            </select>
          </label>
          <button
            type="button"
            className={styles["dh-filter"]}
            disabled={!filtering && props.value.sort === "loaded"}
            onClick={() => props.onChange({ ...defaultWorkspaceFilters })}
          >
            Clear filters
          </button>
        </div>
        <p className={styles["dh-nav-note"]}>
          Search covers this loaded page and the selected context. Other pages and external agents
          are not searched.
          {props.agentsUnavailable
            ? " Agent state is last observed; activity matches cannot be confirmed."
            : ""}
        </p>
      </details>
      <p className={filterStyles.result} role="status" aria-live="polite">
        {props.loading
          ? "Loading workspace contexts…"
          : props.nativeUnavailable
            ? `Connection unavailable. ${result.resources.length} retained contexts shown; current matches cannot be confirmed.`
            : `${result.matchedCount} matching ${result.matchedCount === 1 ? "context" : "contexts"} on this loaded page${props.totalContextCount === undefined ? "" : ` (${result.loadedCount} loaded; ${props.totalContextCount} contexts in this workspace)`}.${result.uncertainCount ? ` ${result.uncertainCount} additional contexts stay visible because not all of their agent details are available.` : ""}`}
        {!props.loading && !props.nativeUnavailable && !result.resources.length
          ? filtering
            ? " No loaded contexts match. Clear filters or load another page."
            : " No contexts are loaded on this page."
          : null}
      </p>
    </section>
  );
}
