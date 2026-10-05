import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { randomUUID } from "../lib/utils";
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@cinderdeck/contracts";
import type {
  GitHubWorkspaceFilters,
  GitHubWorkspaceRepository,
  GitHubWorkspaceRequest,
} from "@cinderdeck/contracts/deckhand/gitHubWorkspace";
import {
  BookIcon,
  LockIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SidebarIcon,
  SlidersHorizontalIcon,
  StarIcon,
  InboxIcon,
} from "lucide-react";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { ProductNavigation } from "./ProductNavigation";
import { NativeGitHubSettingsButton } from "./NativeToolsSettings";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import { useGitHubWorkspace } from "./useGitHubWorkspace";
import {
  GitHubPullRequestInspector,
  checksLabel,
  requestState,
} from "./GitHubPullRequestInspector";
import styles from "./gitHubPullRequests.module.css";

export function GitHubPullRequests({
  environmentId: requested,
}: {
  environmentId?: EnvironmentId | undefined;
}) {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const [chosen, setChosen] = useState<EnvironmentId | undefined>(requested);
  const environmentId = chosen ?? primary ?? environments[0]?.environmentId;
  const environment = environments.find((item) => item.environmentId === environmentId);
  return (
    <div className={styles.shell}>
      <ProductNavigation
        current="pull-requests"
        {...(environment
          ? {
              connection: {
                label: environment.label,
                connected: environment.connection.phase === "connected",
              },
            }
          : {})}
      >
        {environments.length > 1 ? (
          <label className={styles.computer}>
            Computer
            <select
              aria-label="GitHub execution computer"
              value={environmentId ?? ""}
              onChange={(event) => setChosen(event.target.value as EnvironmentId)}
            >
              {environments.map((item) => (
                <option key={item.environmentId} value={item.environmentId}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </ProductNavigation>
      {environment && environmentId ? (
        <GitHubBrowser
          key={environmentId}
          environmentId={environmentId}
          connected={environment.connection.phase === "connected"}
        />
      ) : (
        <main className={styles.empty}>
          <PullRequestGlyph.pullRequest size={32} />
          <h1>Pull requests</h1>
          <p>Connect an execution computer to use your GitHub account.</p>
          <Link to="/settings/connections">Manage connections</Link>
        </main>
      )}
    </div>
  );
}
function GitHubBrowser({
  environmentId,
  connected,
}: {
  environmentId: EnvironmentId;
  connected: boolean;
}) {
  const model = useGitHubWorkspace(environmentId, connected);
  const { preferences, filters } = model;
  const [repositorySearch, setRepositorySearch] = useState("");
  const [starredOnly, setStarredOnly] = useState(false);
  const [showsSidebar, setShowsSidebar] = useState(true);
  const [showsFilters, setShowsFilters] = useState(true);
  const [selected, setSelected] = useState<GitHubWorkspaceRequest | null>(null);
  const [editor, setEditor] = useState<{ id?: string | undefined; name: string } | null>(null);
  const [name, setName] = useState("");
  const [showOthers, setShowOthers] = useState(true);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const identity = preferences
    ? { account: preferences.account, hostname: preferences.hostname }
    : null;
  const patch = (value: Partial<GitHubWorkspaceFilters>) => {
    if (!filters || model.busy) return;
    setSelected(null);
    model.setFilters({ ...filters, ...value });
  };
  const groups = useMemo(
    () =>
      repositoryGroups(
        model.repositories,
        filters?.organization ?? null,
        starredOnly,
        repositorySearch,
        preferences?.account ?? "",
      ),
    [
      model.repositories,
      filters?.organization,
      starredOnly,
      repositorySearch,
      preferences?.account,
    ],
  );
  const activeView = preferences?.views.find((view) => view.id === preferences.selectedViewID);
  const modified =
    filters && activeView
      ? JSON.stringify(
          activeView.builtIn
            ? {
                ...activeView.filters,
                repository: filters.repository,
                organization: filters.organization,
              }
            : activeView.filters,
        ) !== JSON.stringify(filters)
      : false;
  const openEditor = (id?: string, initial = "") => {
    setName(initial);
    setEditor({ id, name: initial });
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r") {
        event.preventDefault();
        model.refresh();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [model.refresh]);
  const accountKey = preferences ? `${preferences.hostname}/${preferences.account}` : "";
  useEffect(() => {
    setSelected(null);
    setEditor(null);
    setRepositorySearch("");
    setStarredOnly(false);
  }, [accountKey]);
  const selectView = async (id: string) => {
    if (!identity) return false;
    setSelected(null);
    return await model.mutate({ action: "select", ...identity, id });
  };
  const repositoryRow = (repository: GitHubWorkspaceRepository) => (
    <div
      className={styles.repositoryRow}
      key={repository.id}
      data-selected={filters?.repository === repository.nameWithOwner}
    >
      <button
        type="button"
        onClick={() =>
          patch({
            repository: repository.nameWithOwner,
            organization: filters?.organization ?? null,
          })
        }
        aria-label={repository.nameWithOwner}
      >
        {repository.isPrivate ? <LockIcon size={13} /> : <BookIcon size={13} />}
        <span>
          <strong>{repository.nameWithOwner.split("/")[1]}</strong>
          <small>
            {repository.nameWithOwner.split("/")[0]}
            {repository.isArchived ? " · Archived" : ""}
          </small>
        </span>
      </button>
      <button
        type="button"
        disabled={model.busy || !identity}
        aria-label={`${repository.viewerHasStarred ? "Unstar" : "Star"} ${repository.nameWithOwner} on GitHub`}
        onClick={() => {
          if (identity)
            void model.mutate({
              action: "star",
              ...identity,
              repository,
              starred: !repository.viewerHasStarred,
            });
        }}
      >
        <StarIcon
          size={13}
          className={repository.viewerHasStarred ? styles.star : undefined}
          fill={repository.viewerHasStarred ? "currentColor" : "none"}
        />
      </button>
    </div>
  );
  const repositoryRows = (starred: boolean) =>
    groups
      .filter((group) => group.starred === starred)
      .map((group) => (
        <section key={group.owner}>
          {!filters?.organization ? (
            <p className={styles.owner}>
              {group.owner.toLowerCase() === preferences?.account.toLowerCase()
                ? `Personal · ${group.owner}`
                : group.owner}
              <span>{group.repositories.length}</span>
            </p>
          ) : null}
          {group.repositories.map(repositoryRow)}
        </section>
      ));
  return (
    <main className={styles.workspace}>
      {showsSidebar ? (
        <aside className={styles.sidebar} aria-label="GitHub repositories">
          <header>
            <PullRequestGlyph.pullRequest size={28} />
            <div>
              <strong>Cinderdeck</strong>
              <small>GITHUB WORKSPACE</small>
            </div>
          </header>
          <button
            type="button"
            className={styles.myWork}
            data-selected={!filters?.repository && !filters?.organization}
            onClick={() => patch({ repository: null, organization: null })}
          >
            <InboxIcon size={17} />
            My work
          </button>
          <label className={styles.sectionLabel} htmlFor="prs-organization">
            Organizations
          </label>
          <select
            id="prs-organization"
            value={filters?.organization ?? ""}
            disabled={!preferences || model.busy}
            onChange={(event) =>
              patch({ organization: event.target.value || null, repository: null })
            }
          >
            <option value="">All repositories</option>
            {[
              ...new Set([
                ...model.organizations,
                ...(filters?.organization ? [filters.organization] : []),
              ]),
            ]
              .sort()
              .map((org) => (
                <option key={org}>{org}</option>
              ))}
          </select>
          <div className={styles.sectionHeading}>
            <span className={styles.sectionLabel}>Repositories</span>
            <button
              type="button"
              aria-label="Show only starred repositories"
              aria-pressed={starredOnly}
              onClick={() => setStarredOnly(!starredOnly)}
            >
              <StarIcon size={14} fill={starredOnly ? "currentColor" : "none"} />
            </button>
          </div>
          <label className={styles.repoSearch}>
            <SearchIcon size={13} />
            <input
              placeholder="Find a repository"
              aria-label="Find a repository"
              value={repositorySearch}
              onChange={(event) => setRepositorySearch(event.target.value)}
            />
          </label>
          <div className={styles.repositories}>
            {model.discovering ? <p role="status">Loading repositories…</p> : null}
            {model.repositoryError ? (
              <p role="alert">
                {model.repositoryError}
                <button type="button" onClick={() => void model.connect()}>
                  Retry
                </button>
              </p>
            ) : null}
            {groups.some((group) => group.starred) ? (
              <>
                <p className={styles.groupTitle}>
                  Favorites{" "}
                  <span>
                    {groups
                      .filter((group) => group.starred)
                      .reduce((sum, group) => sum + group.repositories.length, 0)}
                  </span>
                </p>
                {repositoryRows(true)}
              </>
            ) : null}
            {groups.some((group) => !group.starred) ? (
              <>
                <button
                  type="button"
                  className={styles.groupTitle}
                  aria-expanded={showOthers || !!repositorySearch}
                  onClick={() => setShowOthers(!showOthers)}
                >
                  {showOthers || repositorySearch ? "▾" : "▸"} Other repositories
                  <span>
                    {groups
                      .filter((group) => !group.starred)
                      .reduce((sum, group) => sum + group.repositories.length, 0)}
                  </span>
                </button>
                {showOthers || repositorySearch ? repositoryRows(false) : null}
              </>
            ) : null}
            {!groups.length && !model.discovering && preferences ? (
              <p>
                {starredOnly ? "Star repositories to keep them here." : "No repositories found."}
              </p>
            ) : null}
          </div>
          <footer>
            <span className={styles.avatar}>
              {preferences?.account.slice(0, 1).toUpperCase() ?? "?"}
            </span>
            <span>
              <strong>{preferences?.account ?? "Not connected"}</strong>
              <small>{preferences?.hostname ?? "GitHub"}</small>
            </span>
            <NativeGitHubSettingsButton iconOnly />
            <button
              type="button"
              aria-label="Reconnect GitHub"
              disabled={model.connecting || model.busy}
              onClick={() => void model.connect()}
            >
              <RefreshCwIcon size={14} />
            </button>
          </footer>
        </aside>
      ) : null}
      <section className={styles.main}>
        <header className={styles.header}>
          <button
            type="button"
            aria-label="Toggle repository sidebar"
            onClick={() => setShowsSidebar(!showsSidebar)}
          >
            <SidebarIcon size={17} />
          </button>
          <div>
            <h1>Pull requests</h1>
            <p>
              {filters?.repository ??
                (filters?.organization
                  ? `${filters.organization} · all accessible repositories`
                  : "My work · pull requests you’re involved in")}
            </p>
          </div>
          <div className={styles.headerActions}>
            <button
              type="button"
              disabled={!preferences}
              onClick={() => setShowsFilters(!showsFilters)}
              aria-pressed={showsFilters}
            >
              <SlidersHorizontalIcon size={14} />
              Filters
            </button>
            <button
              type="button"
              aria-label="Refresh pull requests"
              disabled={!preferences || model.loading}
              onClick={model.refresh}
            >
              <RefreshCwIcon size={14} />
            </button>
          </div>
        </header>
        {preferences && filters ? (
          <>
            <nav className={styles.tabs} aria-label="Pull request views">
              <div>
                {preferences.views.map((view) => (
                  <div key={view.id} className={styles.viewTab}>
                    <button
                      type="button"
                      disabled={model.busy}
                      aria-current={preferences.selectedViewID === view.id ? "page" : undefined}
                      onClick={() => void selectView(view.id)}
                    >
                      {view.name}
                      {preferences.selectedViewID === view.id && modified ? (
                        <i aria-label="Modified filters" />
                      ) : null}
                    </button>
                    {!view.builtIn ? (
                      <details>
                        <summary aria-label={`Manage ${view.name} view`}>⌄</summary>
                        <div className={styles.viewMenu}>
                          <button
                            type="button"
                            disabled={model.busy}
                            onClick={() => {
                              void selectView(view.id).then((saved) => {
                                if (saved) openEditor(view.id, view.name);
                              });
                            }}
                          >
                            Edit saved view…
                          </button>
                          {([-1, 1] as const).map((direction) => (
                            <button
                              key={direction}
                              type="button"
                              disabled={model.busy}
                              onClick={() => {
                                const ids = preferences.views
                                  .filter((item) => !item.builtIn)
                                  .map((item) => item.id);
                                const index = ids.indexOf(view.id);
                                const other = index + direction;
                                if (other < 0 || other >= ids.length || !identity) return;
                                [ids[index], ids[other]] = [ids[other]!, ids[index]!];
                                void model.mutate({ action: "reorder", ...identity, ids });
                              }}
                            >
                              Move {direction < 0 ? "left" : "right"}
                            </button>
                          ))}
                          <button
                            type="button"
                            disabled={model.busy}
                            onClick={() => {
                              if (identity)
                                void model.mutate({ action: "delete", ...identity, id: view.id });
                            }}
                          >
                            Delete view
                          </button>
                        </div>
                      </details>
                    ) : null}
                  </div>
                ))}
              </div>
              <button
                type="button"
                aria-label="New saved view"
                disabled={model.busy}
                onClick={() => openEditor()}
              >
                <PlusIcon size={16} />
              </button>
            </nav>
            {showsFilters ? (
              <fieldset className={styles.filters} disabled={model.busy}>
                <label className={styles.query}>
                  <SearchIcon size={14} />
                  <input
                    aria-label="Search pull requests"
                    placeholder={
                      filters.advanced
                        ? "GitHub query, e.g. is:open author:@me label:bug"
                        : "Search pull requests…"
                    }
                    value={filters.text}
                    onChange={(event) => patch({ text: event.target.value })}
                  />
                  <button
                    type="button"
                    aria-pressed={filters.advanced}
                    onClick={() => patch({ advanced: !filters.advanced })}
                  >
                    Query
                  </button>
                </label>
                <div className={styles.filterRow}>
                  {!filters.advanced ? (
                    <>
                      <select
                        aria-label="State"
                        value={filters.state}
                        onChange={(event) =>
                          patch({ state: event.target.value as GitHubWorkspaceFilters["state"] })
                        }
                      >
                        {Object.entries(states).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <input
                        aria-label="Filter by label"
                        placeholder="Label"
                        value={filters.label}
                        onChange={(event) => patch({ label: event.target.value })}
                      />
                    </>
                  ) : null}
                  <select
                    aria-label="Role"
                    value={filters.role}
                    onChange={(event) =>
                      patch({ role: event.target.value as GitHubWorkspaceFilters["role"] })
                    }
                  >
                    {Object.entries(roles).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Sort pull requests"
                    value={filters.sort}
                    onChange={(event) =>
                      patch({ sort: event.target.value as GitHubWorkspaceFilters["sort"] })
                    }
                  >
                    {Object.entries(sorts).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  {modified && activeView && !activeView.builtIn ? (
                    <button
                      type="button"
                      onClick={() => {
                        if (identity)
                          void model.mutate({
                            action: "upsert",
                            ...identity,
                            id: activeView.id,
                            name: activeView.name,
                            filters,
                            select: true,
                          });
                      }}
                    >
                      Save changes
                    </button>
                  ) : null}
                </div>
              </fieldset>
            ) : null}
            {model.error ? (
              <p className={styles.error} role="alert">
                {model.error}
                <button type="button" onClick={() => void model.connect()}>
                  Reconnect
                </button>
              </p>
            ) : null}
            <div className={styles.body}>
              <section className={styles.requestList} aria-label="Pull requests">
                <div className={styles.count}>
                  <span>
                    {model.count} pull request{model.count === 1 ? "" : "s"}
                  </span>
                  {model.loading ? <span role="status">Loading…</span> : null}
                </div>
                <div className={styles.rows}>
                  {model.requests.map((request) => (
                    <button
                      type="button"
                      key={request.id}
                      className={styles.requestRow}
                      aria-pressed={selected?.id === request.id}
                      onClick={() => setSelected(request)}
                    >
                      <PullRequestGlyph.pullRequest
                        size={18}
                        className={styles[requestState(request).toLowerCase()]}
                      />
                      <span>
                        <strong>
                          {request.title}
                          <small>#{request.number}</small>
                        </strong>
                        <span>
                          {request.repository.nameWithOwner} ·{" "}
                          {request.author?.login ?? "Deleted user"}
                        </span>
                        <span className={styles.statusLine}>
                          <b className={styles[requestState(request).toLowerCase()]}>
                            {requestState(request)}
                          </b>
                          <span>{checksLabel(request)}</span>
                          <span className={styles.additions}>+{request.additions}</span>
                          <span className={styles.deletions}>−{request.deletions}</span>
                          <time dateTime={request.updatedAt}>
                            {relativeTime(request.updatedAt)}
                          </time>
                        </span>
                      </span>
                    </button>
                  ))}
                  {!model.requests.length ? (
                    <div className={styles.empty}>
                      <PullRequestGlyph.pullRequest size={30} />
                      <h2>
                        {model.loading
                          ? "Loading pull requests…"
                          : model.error
                            ? "Couldn’t load pull requests"
                            : "You’re all caught up"}
                      </h2>
                      <p>
                        {model.loading
                          ? "Fetching your latest work from GitHub."
                          : "No pull requests match this view. Try another tab or adjust your filters."}
                      </p>
                      <button
                        type="button"
                        disabled={model.loading}
                        onClick={() =>
                          patch({ text: "", label: "", advanced: false, state: "all" })
                        }
                      >
                        Clear filters
                      </button>
                    </div>
                  ) : null}
                </div>
                {model.after && model.requests.length < 1000 ? (
                  <button
                    type="button"
                    className={styles.loadMore}
                    disabled={model.loading}
                    onClick={() => void model.loadMore()}
                  >
                    Load more · {model.requests.length} of {model.count}
                  </button>
                ) : model.requests.length >= 1000 && model.count > 1000 ? (
                  <p className={styles.count}>
                    Showing GitHub’s first 1,000 results. Narrow your filters to see more.
                  </p>
                ) : null}
              </section>
              {selected && identity ? (
                <GitHubPullRequestInspector
                  key={`${accountKey}/${selected.id}`}
                  request={model.requests.find((item) => item.id === selected.id) ?? selected}
                  identity={identity}
                  run={model.run}
                  refreshToken={detailRefresh}
                  onClose={() => setSelected(null)}
                  onReviewed={() => {
                    model.refresh();
                    setDetailRefresh((token) => token + 1);
                  }}
                />
              ) : null}
            </div>
          </>
        ) : (
          <div className={styles.empty}>
            <PullRequestGlyph.pullRequest size={38} />
            <h2>{model.connecting ? "Connecting to GitHub…" : "Connect your GitHub account"}</h2>
            <p>
              {model.error ??
                "Use your GitHub account to browse repositories, favorites and saved pull request views."}
            </p>
            <NativeGitHubSettingsButton />
            <button type="button" disabled={model.connecting} onClick={() => void model.connect()}>
              Check connection
            </button>
          </div>
        )}
      </section>
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open && !model.busy) setEditor(null);
        }}
      >
        <DialogPopup showCloseButton={!model.busy}>
          <DialogHeader>
            <DialogTitle>{editor?.id ? "Edit saved view" : "Save a new view"}</DialogTitle>
            <DialogDescription>
              Keep this repository, search, filters, and sort order in a tab you can return to.
            </DialogDescription>
          </DialogHeader>
          <div className={styles.editor}>
            <label>
              View name
              <input
                value={name}
                maxLength={40}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <small>{name.length}/40</small>
            {model.error ? <p role="alert">{model.error}</p> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={model.busy} onClick={() => setEditor(null)}>
              Cancel
            </Button>
            <Button
              disabled={!name.trim() || model.busy || !identity || !filters}
              onClick={() => {
                if (identity && filters)
                  void model
                    .mutate({
                      action: "upsert",
                      ...identity,
                      id: editor?.id ?? randomUUID(),
                      name: name.trim(),
                      filters,
                      select: true,
                    })
                    .then((saved) => {
                      if (saved) setEditor(null);
                    });
              }}
            >
              Save view
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </main>
  );
}
const states = {
  all: "Any state",
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed, unmerged",
};
const roles = {
  anyone: "Anyone",
  author: "Created by me",
  review: "Review requested",
  assigned: "Assigned to me",
  involved: "Involving me",
};
const sorts = {
  updated: "Recently updated",
  newest: "Newest first",
  oldest: "Oldest first",
  comments: "Most discussed",
};
function relativeTime(value: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  return minutes < 1
    ? "Just now"
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
}
function repositoryGroups(
  repositories: ReadonlyArray<GitHubWorkspaceRepository>,
  organization: string | null,
  starredOnly: boolean,
  search: string,
  account: string,
) {
  const groups = new Map<
    string,
    { owner: string; starred: boolean; repositories: GitHubWorkspaceRepository[] }
  >();
  for (const repo of repositories
    .filter(
      (repo) =>
        (!organization ||
          repo.nameWithOwner.split("/")[0]?.toLowerCase() === organization.toLowerCase()) &&
        (!starredOnly || repo.viewerHasStarred) &&
        repo.nameWithOwner.toLowerCase().includes(search.toLowerCase()),
    )
    .sort((a, b) => a.nameWithOwner.localeCompare(b.nameWithOwner))) {
    const owner = repo.nameWithOwner.split("/")[0]!;
    const key = `${owner}/${repo.viewerHasStarred}`;
    const group = groups.get(key) ?? { owner, starred: repo.viewerHasStarred, repositories: [] };
    group.repositories.push(repo);
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.owner.toLowerCase() === account.toLowerCase()) -
        Number(a.owner.toLowerCase() === account.toLowerCase()) || a.owner.localeCompare(b.owner),
  );
}
