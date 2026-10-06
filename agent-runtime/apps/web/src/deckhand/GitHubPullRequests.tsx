import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { randomUUID } from "../lib/utils";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId } from "@cinderdeck/contracts";
import type {
  GitHubWorkspaceFilters,
  GitHubWorkspaceRepository,
  GitHubWorkspaceRequest,
} from "@cinderdeck/contracts/deckhand/gitHubWorkspace";
import {
  BookIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  ClockIcon,
  InboxIcon,
  LockIcon,
  MoreHorizontalIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  StarIcon,
  XCircleIcon,
  XIcon,
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
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import { useGitHubWorkspace } from "./useGitHubWorkspace";
import {
  GitHubPullRequestInspector,
  checksLabel,
  requestState,
} from "./GitHubPullRequestInspector";
import native from "./nativeWorkspace.module.css";
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
    <div className={`${styles.shell} ${native.workspace}`}>
      <ProductNavigation
        current="pull-requests"
        workspaceSearch={environmentId ? { environment: environmentId } : {}}
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
        <main className={styles.workspace}>
          <EmptyState
            title="Pull requests"
            detail="Connect an execution computer to use your GitHub account."
          >
            <Link to="/settings/connections">Manage connections</Link>
          </EmptyState>
        </main>
      )}
    </div>
  );
}

/** A handler whose identity never changes, so memoized rows are not redrawn for a new closure. */
function useStableHandler<Args extends unknown[]>(handler: (...args: Args) => void) {
  const ref = useRef(handler);
  useLayoutEffect(() => {
    ref.current = handler;
  });
  return useCallback((...args: Args) => ref.current(...args), []);
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
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [lastSelected, setLastSelected] = useState<GitHubWorkspaceRequest | null>(null);
  const [editor, setEditor] = useState<{ id?: string | undefined; name: string } | null>(null);
  const [name, setName] = useState("");
  const [showOthers, setShowOthers] = useState(true);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const account = preferences?.account;
  const hostname = preferences?.hostname;
  const identity = useMemo(
    () => (account && hostname ? { account, hostname } : null),
    [account, hostname],
  );
  const patch = (value: Partial<GitHubWorkspaceFilters>) => {
    if (!filters || model.busy) return;
    model.setFilters({ ...filters, ...value });
  };
  // Changing scope shows other pull requests, so the open one closes; narrowing the same scope
  // keeps it open while the reader refines the list.
  const openScope = useStableHandler((repository: string | null, organization: string | null) => {
    if (!filters || model.busy) return;
    setSelectedID(null);
    model.setFilters({ ...filters, repository, organization });
  });
  const starRepository = useStableHandler((repository: GitHubWorkspaceRepository) => {
    if (identity)
      void model.mutate({
        action: "star",
        ...identity,
        repository,
        starred: !repository.viewerHasStarred,
      });
  });
  const selectRequest = useCallback((request: GitHubWorkspaceRequest) => {
    setSelectedID(request.id);
    setLastSelected(request);
  }, []);
  const closeInspector = useCallback(() => setSelectedID(null), []);
  const refresh = model.refresh;
  const onReviewed = useCallback(() => {
    refresh();
    setDetailRefresh((token) => token + 1);
  }, [refresh]);
  const groups = useMemo(
    () =>
      repositoryGroups(
        model.repositories,
        filters?.organization ?? null,
        starredOnly,
        repositorySearch,
        account ?? "",
      ),
    [model.repositories, filters?.organization, starredOnly, repositorySearch, account],
  );
  const organizations = [
    ...new Set([...model.organizations, ...(filters?.organization ? [filters.organization] : [])]),
  ].sort();
  const activeView = preferences?.views.find((view) => view.id === preferences.selectedViewID);
  const modified = useMemo(
    () =>
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
        : false,
    [activeView, filters],
  );
  const openEditor = (id?: string, initial = "") => {
    setName(initial);
    setEditor({ id, name: initial });
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r") {
        event.preventDefault();
        refresh();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refresh]);
  const accountKey = preferences ? `${preferences.hostname}/${preferences.account}` : "";
  useEffect(() => {
    setSelectedID(null);
    setEditor(null);
    setRepositorySearch("");
    setStarredOnly(false);
  }, [accountKey]);
  const selectView = async (id: string) => {
    if (!identity) return false;
    setSelectedID(null);
    return await model.mutate({ action: "select", ...identity, id });
  };
  const moveView = (id: string, direction: -1 | 1) => {
    if (!preferences || !identity) return;
    const ids = preferences.views.filter((item) => !item.builtIn).map((item) => item.id);
    const index = ids.indexOf(id);
    const other = index + direction;
    if (other < 0 || other >= ids.length) return;
    [ids[index], ids[other]] = [ids[other]!, ids[index]!];
    void model.mutate({ action: "reorder", ...identity, ids });
  };
  const selected =
    selectedID === null
      ? null
      : (model.requests.find((item) => item.id === selectedID) ??
        (lastSelected?.id === selectedID ? lastSelected : null));
  const scopeLabel =
    filters?.repository ??
    (filters?.organization
      ? `${filters.organization} · all accessible repositories`
      : "My work · pull requests you’re involved in");
  const stale = model.loading && !model.settled && model.requests.length > 0;
  return (
    <main className={styles.workspace}>
      {showsSidebar ? (
        <RepositorySidebar
          groups={groups}
          organizations={organizations}
          organization={filters?.organization ?? null}
          repository={filters?.repository ?? null}
          account={account ?? null}
          hostname={hostname ?? null}
          ready={!!preferences}
          busy={model.busy}
          connecting={model.connecting}
          discovering={model.discovering}
          repositoryError={model.repositoryError}
          search={repositorySearch}
          onSearch={setRepositorySearch}
          starredOnly={starredOnly}
          onStarredOnly={setStarredOnly}
          showOthers={showOthers}
          onShowOthers={setShowOthers}
          onOpenScope={openScope}
          onStar={starRepository}
          onReconnect={model.connect}
        />
      ) : null}
      <section className={styles.main}>
        <header className={styles.header}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label="Toggle repository sidebar"
            onClick={() => setShowsSidebar(!showsSidebar)}
          >
            {showsSidebar ? <PanelLeftCloseIcon size={16} /> : <PanelLeftOpenIcon size={16} />}
          </button>
          <div className={styles.heading}>
            <h1>Pull requests</h1>
            <p>{scopeLabel}</p>
          </div>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.control}
              disabled={!preferences}
              onClick={() => setShowsFilters(!showsFilters)}
              aria-pressed={showsFilters}
            >
              <SlidersHorizontalIcon size={14} />
              Filters
            </button>
            <button
              type="button"
              className={styles.control}
              aria-label="Refresh pull requests"
              disabled={!preferences || model.loading}
              onClick={refresh}
            >
              <RefreshCwIcon size={14} className={model.loading ? styles.spinning : undefined} />
            </button>
          </div>
        </header>
        {preferences && filters ? (
          <>
            <nav className={styles.tabs} aria-label="Pull request views">
              <div className={styles.tabList}>
                {preferences.views.map((view) => (
                  <div
                    key={view.id}
                    className={styles.viewTab}
                    data-current={preferences.selectedViewID === view.id}
                  >
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
                      <Menu>
                        <MenuTrigger
                          render={<button type="button" className={styles.viewMenuTrigger} />}
                          aria-label={`Manage ${view.name} view`}
                          disabled={model.busy}
                        >
                          <MoreHorizontalIcon size={14} />
                        </MenuTrigger>
                        <MenuPopup align="start" className="min-w-44">
                          <MenuItem
                            onClick={() => {
                              void selectView(view.id).then((saved) => {
                                if (saved) openEditor(view.id, view.name);
                              });
                            }}
                          >
                            Edit saved view…
                          </MenuItem>
                          <MenuItem onClick={() => moveView(view.id, -1)}>Move left</MenuItem>
                          <MenuItem onClick={() => moveView(view.id, 1)}>Move right</MenuItem>
                          <MenuSeparator />
                          <MenuItem
                            variant="destructive"
                            onClick={() => {
                              if (identity)
                                void model.mutate({ action: "delete", ...identity, id: view.id });
                            }}
                          >
                            Delete view
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    ) : null}
                  </div>
                ))}
              </div>
              <button
                type="button"
                className={styles.iconButton}
                aria-label="New saved view"
                disabled={model.busy}
                onClick={() => openEditor()}
              >
                <PlusIcon size={15} />
              </button>
            </nav>
            {showsFilters ? (
              <fieldset className={styles.filters} disabled={model.busy}>
                <label className={styles.query}>
                  <SearchIcon size={14} aria-hidden />
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
                  {filters.text ? (
                    <button
                      type="button"
                      className={styles.clear}
                      aria-label="Clear search"
                      onClick={() => patch({ text: "" })}
                    >
                      <XIcon size={13} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.queryToggle}
                    aria-pressed={filters.advanced}
                    onClick={() => patch({ advanced: !filters.advanced })}
                  >
                    Query
                  </button>
                </label>
                {!filters.advanced ? (
                  <>
                    <Select
                      label="State"
                      value={filters.state}
                      options={states}
                      onChange={(state) => patch({ state })}
                    />
                    <input
                      className={styles.label}
                      aria-label="Filter by label"
                      placeholder="Label"
                      value={filters.label}
                      onChange={(event) => patch({ label: event.target.value })}
                    />
                  </>
                ) : null}
                <Select
                  label="Role"
                  value={filters.role}
                  options={roles}
                  onChange={(role) => patch({ role })}
                />
                <Select
                  label="Sort pull requests"
                  value={filters.sort}
                  options={sorts}
                  onChange={(sort) => patch({ sort })}
                />
                {modified && activeView && !activeView.builtIn ? (
                  <button
                    type="button"
                    className={styles.saveChanges}
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
              </fieldset>
            ) : null}
            {model.error ? (
              <p className={styles.error} role="alert">
                <span>{model.error}</span>
                <button type="button" onClick={() => void model.connect()}>
                  Reconnect
                </button>
              </p>
            ) : null}
            <div className={styles.body}>
              <section className={styles.requestList} aria-label="Pull requests">
                <div className={styles.count}>
                  <span>
                    {model.loading && !model.settled
                      ? "Finding pull requests…"
                      : `${model.count.toLocaleString()} pull request${model.count === 1 ? "" : "s"}`}
                  </span>
                  {model.loading && model.settled ? <span role="status">Refreshing…</span> : null}
                </div>
                <div className={styles.rows} data-stale={stale} aria-busy={model.loading}>
                  {model.requests.map((request) => (
                    <RequestRow
                      key={request.id}
                      request={request}
                      selected={selectedID === request.id}
                      onSelect={selectRequest}
                    />
                  ))}
                  {!model.requests.length ? (
                    model.loading ? (
                      <RowsPlaceholder />
                    ) : (
                      <EmptyState
                        title={model.error ? "Couldn’t load pull requests" : "You’re all caught up"}
                        detail={
                          model.error
                            ? "Your filters are saved. Retry when you’re ready."
                            : "No pull requests match this view. Try another tab or adjust your filters."
                        }
                      >
                        <button
                          type="button"
                          onClick={() =>
                            model.error
                              ? refresh()
                              : patch({ text: "", label: "", advanced: false, state: "all" })
                          }
                        >
                          {model.error ? "Retry" : "Clear filters"}
                        </button>
                      </EmptyState>
                    )
                  ) : null}
                  {model.after && model.requests.length < 1000 && model.settled ? (
                    <button
                      type="button"
                      className={styles.loadMore}
                      disabled={model.loading}
                      onClick={() => void model.loadMore()}
                    >
                      {model.loading
                        ? "Loading more…"
                        : `Load more · ${model.requests.length} of ${model.count.toLocaleString()}`}
                    </button>
                  ) : model.requests.length >= 1000 && model.count > 1000 ? (
                    <p className={styles.limit}>
                      Showing GitHub’s first 1,000 results. Narrow your filters to see more.
                    </p>
                  ) : null}
                </div>
              </section>
              {selected && identity ? (
                <GitHubPullRequestInspector
                  key={`${accountKey}/${selected.id}`}
                  request={selected}
                  identity={identity}
                  run={model.run}
                  refreshToken={detailRefresh}
                  onClose={closeInspector}
                  onReviewed={onReviewed}
                />
              ) : null}
            </div>
          </>
        ) : (
          <EmptyState
            title={model.connecting ? "Connecting to GitHub…" : "Connect your GitHub account"}
            detail={
              model.error ??
              "Use your GitHub account to browse repositories, favorites and saved pull request views."
            }
          >
            <NativeGitHubSettingsButton />
            <button type="button" disabled={model.connecting} onClick={() => void model.connect()}>
              Check connection
            </button>
          </EmptyState>
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

type RepositoryGroup = ReturnType<typeof repositoryGroups>[number];

const RepositorySidebar = memo(function RepositorySidebar({
  groups,
  organizations,
  organization,
  repository,
  account,
  hostname,
  ready,
  busy,
  connecting,
  discovering,
  repositoryError,
  search,
  onSearch,
  starredOnly,
  onStarredOnly,
  showOthers,
  onShowOthers,
  onOpenScope,
  onStar,
  onReconnect,
}: {
  groups: ReadonlyArray<RepositoryGroup>;
  organizations: ReadonlyArray<string>;
  organization: string | null;
  repository: string | null;
  account: string | null;
  hostname: string | null;
  ready: boolean;
  busy: boolean;
  connecting: boolean;
  discovering: boolean;
  repositoryError: string | null;
  search: string;
  onSearch: (value: string) => void;
  starredOnly: boolean;
  onStarredOnly: (value: boolean) => void;
  showOthers: boolean;
  onShowOthers: (value: boolean) => void;
  onOpenScope: (repository: string | null, organization: string | null) => void;
  onStar: (repository: GitHubWorkspaceRepository) => void;
  onReconnect: () => Promise<void>;
}) {
  const favorites = groups.filter((group) => group.starred);
  const others = groups.filter((group) => !group.starred);
  const othersOpen = showOthers || !!search;
  const total = (items: ReadonlyArray<RepositoryGroup>) =>
    items.reduce((sum, group) => sum + group.repositories.length, 0);
  const rows = (items: ReadonlyArray<RepositoryGroup>) =>
    items.map((group) => (
      <section key={`${group.owner}/${group.starred}`}>
        {!organization ? (
          <p className={styles.owner}>
            <span>
              {account && group.owner.toLowerCase() === account.toLowerCase()
                ? `Personal · ${group.owner}`
                : group.owner}
            </span>
            <span>{group.repositories.length}</span>
          </p>
        ) : null}
        {group.repositories.map((item) => (
          <RepositoryRow
            key={item.id}
            repository={item}
            selected={repository === item.nameWithOwner}
            disabled={busy || !ready}
            organization={organization}
            onOpen={onOpenScope}
            onStar={onStar}
          />
        ))}
      </section>
    ));
  return (
    <aside className={styles.sidebar} aria-label="GitHub repositories">
      <div className={styles.scope}>
        <button
          type="button"
          className={styles.myWork}
          data-selected={!repository && !organization}
          onClick={() => onOpenScope(null, null)}
        >
          <InboxIcon size={15} />
          My work
        </button>
        <label className={styles.sectionLabel} htmlFor="prs-organization">
          Organization
        </label>
        <div className={styles.selectWrap}>
          <select
            id="prs-organization"
            value={organization ?? ""}
            disabled={!ready || busy}
            onChange={(event) => onOpenScope(null, event.target.value || null)}
          >
            <option value="">All repositories</option>
            {organizations.map((org) => (
              <option key={org}>{org}</option>
            ))}
          </select>
          <ChevronDownIcon size={13} aria-hidden />
        </div>
      </div>
      <div className={styles.sectionHeading}>
        <span className={styles.sectionLabel}>Repositories</span>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Show only starred repositories"
          aria-pressed={starredOnly}
          onClick={() => onStarredOnly(!starredOnly)}
        >
          <StarIcon size={13} fill={starredOnly ? "currentColor" : "none"} />
        </button>
      </div>
      <label className={styles.repoSearch}>
        <SearchIcon size={13} aria-hidden />
        <input
          placeholder="Find a repository"
          aria-label="Find a repository"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
        />
      </label>
      <div className={styles.repositories}>
        {repositoryError ? (
          <p role="alert" className={styles.repositoryError}>
            {repositoryError}
            <button type="button" onClick={() => void onReconnect()}>
              Retry
            </button>
          </p>
        ) : null}
        {favorites.length ? (
          <>
            <p className={styles.groupTitle}>
              <span>Favorites</span>
              <span>{total(favorites)}</span>
            </p>
            {rows(favorites)}
          </>
        ) : null}
        {others.length ? (
          <>
            <button
              type="button"
              className={styles.groupTitle}
              aria-expanded={othersOpen}
              onClick={() => onShowOthers(!showOthers)}
            >
              <span>
                {othersOpen ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                Other repositories
              </span>
              <span>{total(others)}</span>
            </button>
            {othersOpen ? rows(others) : null}
          </>
        ) : null}
        {discovering ? (
          <p role="status" className={styles.discovering}>
            Loading repositories…
          </p>
        ) : !groups.length && ready ? (
          <p className={styles.noRepositories}>
            {starredOnly ? "Star repositories to keep them here." : "No repositories found."}
          </p>
        ) : null}
      </div>
      <footer className={styles.account}>
        <span className={styles.avatar}>{account?.slice(0, 1).toUpperCase() ?? "?"}</span>
        <span>
          <strong>{account ?? "Not connected"}</strong>
          <small>{hostname ?? "GitHub"}</small>
        </span>
        <NativeGitHubSettingsButton iconOnly />
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Reconnect GitHub"
          disabled={connecting || busy}
          onClick={() => void onReconnect()}
        >
          <RefreshCwIcon size={13} />
        </button>
      </footer>
    </aside>
  );
});

const RepositoryRow = memo(function RepositoryRow({
  repository,
  selected,
  disabled,
  organization,
  onOpen,
  onStar,
}: {
  repository: GitHubWorkspaceRepository;
  selected: boolean;
  disabled: boolean;
  organization: string | null;
  onOpen: (repository: string | null, organization: string | null) => void;
  onStar: (repository: GitHubWorkspaceRepository) => void;
}) {
  const [owner, repoName] = repository.nameWithOwner.split("/");
  return (
    <div className={styles.repositoryRow} data-selected={selected}>
      <button
        type="button"
        onClick={() => onOpen(repository.nameWithOwner, organization)}
        aria-label={repository.nameWithOwner}
      >
        {repository.isPrivate ? <LockIcon size={13} /> : <BookIcon size={13} />}
        <span>
          <strong>{repoName}</strong>
          <small>
            {owner}
            {repository.isArchived ? " · Archived" : ""}
          </small>
        </span>
      </button>
      <button
        type="button"
        className={styles.star}
        data-starred={repository.viewerHasStarred}
        disabled={disabled}
        aria-label={`${repository.viewerHasStarred ? "Unstar" : "Star"} ${repository.nameWithOwner} on GitHub`}
        onClick={() => onStar(repository)}
      >
        <StarIcon size={12} fill={repository.viewerHasStarred ? "currentColor" : "none"} />
      </button>
    </div>
  );
});

const STATE_GLYPHS = {
  Open: PullRequestGlyph.pullRequest,
  Draft: PullRequestGlyph.draft,
  Merged: PullRequestGlyph.merged,
  Closed: PullRequestGlyph.closed,
} as const;
const CHECK_GLYPHS = {
  Passed: CheckCircle2Icon,
  Failed: XCircleIcon,
  Pending: ClockIcon,
  "No checks": CircleDashedIcon,
} as const;

const RequestRow = memo(function RequestRow({
  request,
  selected,
  onSelect,
}: {
  request: GitHubWorkspaceRequest;
  selected: boolean;
  onSelect: (request: GitHubWorkspaceRequest) => void;
}) {
  const state = requestState(request);
  const checks = checksLabel(request);
  const StateIcon = STATE_GLYPHS[state];
  const ChecksIcon = CHECK_GLYPHS[checks];
  return (
    <button
      type="button"
      className={styles.requestRow}
      aria-pressed={selected}
      onClick={() => onSelect(request)}
    >
      <StateIcon size={16} className={styles.stateIcon} data-state={state} aria-hidden />
      <span className={styles.requestBody}>
        <span className={styles.requestTitle}>
          <strong>{request.title}</strong>
          <time dateTime={request.updatedAt}>{relativeTime(request.updatedAt)}</time>
        </span>
        <span className={styles.requestMeta}>
          <span className={styles.repoName}>{request.repository.nameWithOwner}</span>
          <span className={styles.number}>#{request.number}</span>
          <span>·</span>
          <span>{request.author?.login ?? "Deleted user"}</span>
        </span>
        <span className={styles.statusLine}>
          <span className={styles.badge} data-state={state}>
            {state}
          </span>
          <span className={styles.checks} data-checks={checks}>
            <ChecksIcon size={12} aria-hidden />
            {checks}
          </span>
          <span className={styles.diffStat}>
            <span className={styles.additions}>+{request.additions}</span>
            <span className={styles.deletions}>−{request.deletions}</span>
          </span>
          {request.labels.nodes.slice(0, 3).map((label) => (
            <span key={label.name} className={styles.labelChip}>
              {label.name}
            </span>
          ))}
        </span>
      </span>
    </button>
  );
});

function RowsPlaceholder() {
  return (
    <div className={styles.placeholder} role="status" aria-label="Loading pull requests">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index}>
          <i />
          <span>
            <b />
            <b />
          </span>
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyIcon}>
        <PullRequestGlyph.pullRequest size={22} />
      </span>
      <h2>{title}</h2>
      <p>{detail}</p>
      {children ? <div className={styles.emptyActions}>{children}</div> : null}
    </div>
  );
}

function Select<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: Record<Value, string>;
  onChange: (value: Value) => void;
}) {
  return (
    <span className={styles.selectWrap}>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value as Value)}
      >
        {(Object.entries(options) as Array<[Value, string]>).map(([option, text]) => (
          <option key={option} value={option}>
            {text}
          </option>
        ))}
      </select>
      <ChevronDownIcon size={13} aria-hidden />
    </span>
  );
}

const states: Record<GitHubWorkspaceFilters["state"], string> = {
  all: "Any state",
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed, unmerged",
};
const roles: Record<GitHubWorkspaceFilters["role"], string> = {
  anyone: "Anyone",
  author: "Created by me",
  review: "Review requested",
  assigned: "Assigned to me",
  involved: "Involving me",
};
const sorts: Record<GitHubWorkspaceFilters["sort"], string> = {
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
  const query = search.toLowerCase();
  const scope = organization?.toLowerCase();
  const groups = new Map<
    string,
    { owner: string; starred: boolean; repositories: GitHubWorkspaceRepository[] }
  >();
  for (const repo of repositories
    .filter((repo) => {
      const name = repo.nameWithOwner.toLowerCase();
      return (
        (!scope || name.slice(0, name.indexOf("/")) === scope) &&
        (!starredOnly || repo.viewerHasStarred) &&
        name.includes(query)
      );
    })
    .sort((a, b) => a.nameWithOwner.localeCompare(b.nameWithOwner))) {
    const owner = repo.nameWithOwner.split("/")[0]!;
    const key = `${owner}/${repo.viewerHasStarred}`;
    const group = groups.get(key) ?? { owner, starred: repo.viewerHasStarred, repositories: [] };
    group.repositories.push(repo);
    groups.set(key, group);
  }
  const self = account.toLowerCase();
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.owner.toLowerCase() === self) - Number(a.owner.toLowerCase() === self) ||
      a.owner.localeCompare(b.owner),
  );
}
