import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EnvironmentId } from "@cinderdeck/contracts";
import type {
  GitHubWorkspaceFilters,
  GitHubWorkspaceInput,
  GitHubWorkspacePreferences,
  GitHubWorkspaceRepository,
  GitHubWorkspaceResult,
  GitHubWorkspaceRequest,
} from "@cinderdeck/contracts/deckhand/gitHubWorkspace";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { useAtomCommand } from "../state/use-atom-command";
import { gitHubWorkspaceRequest } from "./gitHubWorkspaceState";

/** A search answered this recently is shown without asking GitHub again. */
const SEARCH_FRESH_MS = 30_000;
/** Repository and organization listings change rarely and take several pages to read. */
const DISCOVERY_FRESH_MS = 5 * 60_000;
const SEARCH_CACHE_LIMIT = 40;
const SEARCH_DEBOUNCE_MS = 300;

interface SearchEntry {
  readonly requests: ReadonlyArray<GitHubWorkspaceRequest>;
  readonly count: number;
  readonly after: string | null;
  readonly at: number;
}
interface DiscoveryEntry {
  repositories: ReadonlyArray<GitHubWorkspaceRepository>;
  organizations: ReadonlyArray<string>;
  /** `organizations`, or `repositories:<org>` for one repository scope, to when it was read. */
  readonly loaded: Map<string, number>;
}

// Kept for the life of the page so returning to pull requests, switching tabs, or switching back
// to an earlier view answers at once and refreshes behind the rows rather than in front of them.
const searchCache = new Map<string, SearchEntry>();
const discoveryCache = new Map<string, DiscoveryEntry>();

export function resetGitHubWorkspaceCache() {
  searchCache.clear();
  discoveryCache.clear();
}

function identityKey(environmentId: EnvironmentId, hostname: string, account: string) {
  return `${environmentId}|${hostname}|${account.toLowerCase()}`;
}
function rememberSearch(key: string, entry: SearchEntry) {
  searchCache.delete(key);
  searchCache.set(key, entry);
  while (searchCache.size > SEARCH_CACHE_LIMIT) {
    const oldest = searchCache.keys().next().value;
    if (oldest === undefined) break;
    searchCache.delete(oldest);
  }
}
function discoveryEntry(key: string) {
  let entry = discoveryCache.get(key);
  if (!entry) {
    entry = { repositories: [], organizations: [], loaded: new Map() };
    discoveryCache.set(key, entry);
  }
  return entry;
}
function mergeRepositories(
  existing: ReadonlyArray<GitHubWorkspaceRepository>,
  next: ReadonlyArray<GitHubWorkspaceRepository>,
) {
  if (!next.length) return existing;
  return [...new Map([...existing, ...next].map((repo) => [repo.id, repo])).values()];
}
function mergeOrganizations(existing: ReadonlyArray<string>, next: ReadonlyArray<string>) {
  if (next.every((org) => existing.includes(org))) return existing;
  return [...new Set([...existing, ...next])].sort();
}
function sameFilters(left: GitHubWorkspaceFilters, right: GitHubWorkspaceFilters) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function useGitHubWorkspace(environmentId: EnvironmentId, connected = true) {
  const command = useAtomCommand(gitHubWorkspaceRequest, { reportFailure: false });
  const [preferences, setPreferences] = useState<GitHubWorkspacePreferences | null>(null);
  const [filters, setFilters] = useState<GitHubWorkspaceFilters | null>(null);
  const [repositories, setRepositories] = useState<ReadonlyArray<GitHubWorkspaceRepository>>([]);
  const [organizations, setOrganizations] = useState<ReadonlyArray<string>>([]);
  const [requests, setRequests] = useState<ReadonlyArray<GitHubWorkspaceRequest>>([]);
  const [count, setCount] = useState(0);
  const [after, setAfter] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [loading, setLoading] = useState(false);
  /** Whether the rows on screen answer the current filters, rather than the previous ones. */
  const [settled, setSettled] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repositoryError, setRepositoryError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [discoveryToken, setDiscoveryToken] = useState(0);
  const epoch = useRef(0);
  const queryEpoch = useRef(0);
  const mutationBusy = useRef(false);
  const serial = useRef<Promise<unknown>>(Promise.resolve());
  const appliedRefresh = useRef(0);
  const appliedDiscovery = useRef(0);
  const lastSearchAt = useRef(0);
  const current = useRef<{
    preferences: GitHubWorkspacePreferences | null;
    filters: GitHubWorkspaceFilters | null;
    loading: boolean;
  }>({ preferences: null, filters: null, loading: false });
  useLayoutEffect(() => {
    current.current = { preferences, filters, loading };
  }, [preferences, filters, loading]);
  const run = useCallback(
    async (input: GitHubWorkspaceInput): Promise<GitHubWorkspaceResult> => {
      const response = await command({ environmentId, input });
      if (response._tag === "Success") return response.value;
      const failure = Option.getOrNull(Cause.findErrorOption(response.cause));
      if (
        failure &&
        "code" in failure &&
        (failure.code === "account_changed" || failure.code === "host_changed")
      )
        throw new Error(
          "Your GitHub account changed. Reconnect to load its saved views and repositories.",
        );
      if (failure && "code" in failure && failure.code === "failed" && "reason" in failure)
        throw new Error(String(failure.reason));
      throw new Error(
        "Could not reach GitHub. Check your GitHub connection in Settings, then retry.",
      );
    },
    [command, environmentId],
  );
  // Native preference writes are ordered, so slower account checks cannot restore an old query.
  const write = useCallback(
    (input: GitHubWorkspaceInput, isCurrent?: () => boolean) => {
      const version = epoch.current;
      const next = serial.current
        .catch(() => undefined)
        .then(() => {
          if (version !== epoch.current || (isCurrent && !isCurrent()))
            throw new Error("GitHub view changed.");
          return run(input);
        });
      serial.current = next;
      return next;
    },
    [run],
  );
  const connect = useCallback(async () => {
    const version = ++epoch.current;
    ++queryEpoch.current;
    setConnecting(true);
    setPreferences(null);
    setFilters(null);
    setRepositories([]);
    setOrganizations([]);
    setRequests([]);
    setAfter(null);
    setCount(0);
    setSettled(false);
    setError(null);
    try {
      const result = await run({ action: "preferences" });
      if (epoch.current !== version) return;
      if (result.kind !== "preferences") throw new Error("Unexpected GitHub response.");
      setPreferences(result.preferences);
      setFilters(result.preferences.filters);
    } catch (cause) {
      if (epoch.current === version) setError(message(cause));
    } finally {
      if (epoch.current === version) setConnecting(false);
    }
  }, [run]);
  /** An explicit reconnect reads everything again instead of answering from memory. */
  const reconnect = useCallback(async () => {
    const identity = current.current.preferences;
    if (identity) {
      const key = identityKey(environmentId, identity.hostname, identity.account);
      discoveryCache.delete(key);
      for (const entry of searchCache.keys())
        if (entry.startsWith(`${key}|`)) searchCache.delete(entry);
    }
    setDiscoveryToken((token) => token + 1);
    await connect();
  }, [connect, environmentId]);
  useEffect(() => {
    if (connected) void connect();
    return () => {
      ++epoch.current;
      ++queryEpoch.current;
    };
  }, [connect, connected]);
  // Returning to the window checks for an account switch or views an agent changed, without
  // clearing what is on screen. Only a different account starts over.
  useEffect(() => {
    if (!connected) return;
    let checking = false;
    const onFocus = () => {
      if (checking || mutationBusy.current) return;
      const before = current.current.preferences;
      if (!before) return;
      checking = true;
      const version = epoch.current;
      void run({ action: "preferences" })
        .then((result) => {
          if (version !== epoch.current || mutationBusy.current || result.kind !== "preferences")
            return;
          const next = result.preferences;
          const latest = current.current;
          if (
            !latest.preferences ||
            next.account.toLowerCase() !== latest.preferences.account.toLowerCase() ||
            next.hostname !== latest.preferences.hostname
          ) {
            void connect();
            return;
          }
          if (latest.loading) return;
          const viewsChanged =
            next.selectedViewID !== latest.preferences.selectedViewID ||
            JSON.stringify(next.views) !== JSON.stringify(latest.preferences.views);
          if (viewsChanged || (latest.filters && !sameFilters(next.filters, latest.filters))) {
            setPreferences(next);
            setFilters(next.filters);
          } else if (Date.now() - lastSearchAt.current > SEARCH_FRESH_MS) {
            setRefreshToken((token) => token + 1);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          checking = false;
        });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [connect, connected, run]);
  const account = preferences?.account;
  const hostname = preferences?.hostname;
  const organization = filters?.organization ?? null;
  const discoveryKey = account && hostname ? identityKey(environmentId, hostname, account) : null;
  const loadPages = useCallback(
    async (
      fetchPage: (cursor: string | null) => Promise<GitHubWorkspaceResult>,
      apply: (result: GitHubWorkspaceResult) => void,
      cancelled: () => boolean,
    ) => {
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const result = await fetchPage(cursor);
        if (cancelled()) return false;
        apply(result);
        const info: { hasNextPage: boolean; endCursor?: string | null } | undefined =
          result.kind === "repositories" || result.kind === "organizations"
            ? result.page.pageInfo
            : undefined;
        cursor = info?.hasNextPage ? (info.endCursor ?? null) : null;
        if (info?.hasNextPage && (!cursor || seen.has(cursor)))
          throw new Error("Repository pagination changed. Reconnect to retry.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return true;
    },
    [],
  );
  // Organizations belong to the account, not the scope, so choosing one does not read them again.
  useEffect(() => {
    if (!account || !hostname || !discoveryKey) return;
    let cancelled = false;
    const entry = discoveryEntry(discoveryKey);
    setOrganizations((existing) => mergeOrganizations(existing, entry.organizations));
    const loadedAt = entry.loaded.get("organizations");
    if (loadedAt !== undefined && Date.now() - loadedAt < DISCOVERY_FRESH_MS) return;
    const identity = { account, hostname };
    void loadPages(
      (cursor) => run({ action: "organizations", ...identity, after: cursor }),
      (result) => {
        if (result.kind !== "organizations") throw new Error("Unexpected organization response.");
        entry.organizations = mergeOrganizations(
          entry.organizations,
          result.page.nodes.map((org) => org.login),
        );
        setOrganizations((existing) => mergeOrganizations(existing, entry.organizations));
      },
      () => cancelled,
    )
      .then((complete) => {
        if (complete) entry.loaded.set("organizations", Date.now());
      })
      .catch((cause) => {
        if (!cancelled) setRepositoryError(message(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [account, hostname, discoveryKey, discoveryToken, loadPages, run]);
  useEffect(() => {
    if (!account || !hostname || !discoveryKey) return;
    let cancelled = false;
    const entry = discoveryEntry(discoveryKey);
    const scope = `repositories:${organization ?? ""}`;
    setRepositories((existing) => mergeRepositories(existing, entry.repositories));
    const forced = appliedDiscovery.current !== discoveryToken;
    appliedDiscovery.current = discoveryToken;
    const loadedAt = entry.loaded.get(scope);
    if (!forced && loadedAt !== undefined && Date.now() - loadedAt < DISCOVERY_FRESH_MS) {
      setDiscovering(false);
      return;
    }
    setDiscovering(true);
    setRepositoryError(null);
    const identity = { account, hostname };
    void loadPages(
      (cursor) => run({ action: "repositories", ...identity, organization, after: cursor }),
      (result) => {
        if (result.kind !== "repositories") throw new Error("Unexpected repository response.");
        entry.repositories = mergeRepositories(entry.repositories, result.page.nodes);
        setRepositories((existing) => mergeRepositories(existing, result.page.nodes));
      },
      () => cancelled,
    )
      .then((complete) => {
        if (complete) entry.loaded.set(scope, Date.now());
      })
      .catch((cause) => {
        if (!cancelled) setRepositoryError(message(cause));
      })
      .finally(() => {
        if (!cancelled) setDiscovering(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account, hostname, organization, discoveryKey, discoveryToken, loadPages, run]);
  useEffect(() => {
    if (!preferences || !filters) return;
    const version = ++queryEpoch.current;
    const connection = epoch.current;
    let cancelled = false;
    const key = `${identityKey(environmentId, preferences.hostname, preferences.account)}|${JSON.stringify(filters)}`;
    const forced = appliedRefresh.current !== refreshToken;
    appliedRefresh.current = refreshToken;
    const cached = forced ? undefined : searchCache.get(key);
    const fresh = cached !== undefined && Date.now() - cached.at < SEARCH_FRESH_MS;
    const needsWrite = !sameFilters(filters, preferences.filters);
    // Rows for other filters stay on screen, dimmed, until the answer arrives; the list never
    // blanks while typing or switching views.
    if (cached) {
      setRequests(cached.requests);
      setCount(cached.count);
      setAfter(cached.after);
      setSettled(true);
      setError(null);
      lastSearchAt.current = cached.at;
    } else setSettled(false);
    setLoading(!fresh);
    if (fresh && !needsWrite) return;
    const timer = setTimeout(
      () => {
        void (async () => {
          try {
            if (needsWrite)
              await write(
                {
                  action: "workspace",
                  account: preferences.account,
                  hostname: preferences.hostname,
                  id: preferences.selectedViewID,
                  filters,
                },
                () => !cancelled && version === queryEpoch.current,
              );
            if (fresh || cancelled || epoch.current !== connection) return;
            const result = await run({
              action: "search",
              account: preferences.account,
              hostname: preferences.hostname,
              filters,
            });
            if (result.kind !== "search") throw new Error("Unexpected search response.");
            const entry: SearchEntry = {
              requests: result.requests,
              count: result.count,
              after: result.pageInfo.hasNextPage ? (result.pageInfo.endCursor ?? null) : null,
              at: Date.now(),
            };
            rememberSearch(key, entry);
            if (cancelled || version !== queryEpoch.current || epoch.current !== connection) return;
            lastSearchAt.current = entry.at;
            setRequests(entry.requests);
            setCount(entry.count);
            setAfter(entry.after);
            setSettled(true);
            setError(null);
          } catch (cause) {
            if (!cancelled && epoch.current === connection && version === queryEpoch.current)
              setError(message(cause));
          } finally {
            if (!cancelled && epoch.current === connection && version === queryEpoch.current)
              setLoading(false);
          }
        })();
      },
      // A remembered answer is already on screen, so its refresh need not wait for more typing.
      cached ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [environmentId, preferences, filters, refreshToken, run, write]);
  const mutate = async (input: GitHubWorkspaceInput) => {
    if (mutationBusy.current) return false;
    mutationBusy.current = true;
    if (["select", "upsert", "delete", "reorder"].includes(input.action)) ++queryEpoch.current;
    const version = epoch.current;
    setBusy(true);
    setError(null);
    try {
      const result = await write(input);
      if (version !== epoch.current) return false;
      if (result.kind === "preferences") {
        setPreferences(result.preferences);
        setFilters(result.preferences.filters);
      } else if (result.kind === "star") {
        const star = (repos: ReadonlyArray<GitHubWorkspaceRepository>) =>
          repos.map((repo) =>
            repo.id === result.repositoryID ? { ...repo, viewerHasStarred: result.starred } : repo,
          );
        if (discoveryKey) {
          const entry = discoveryCache.get(discoveryKey);
          if (entry) entry.repositories = star(entry.repositories);
        }
        setRepositories(star);
      }
      return true;
    } catch (cause) {
      if (version === epoch.current) {
        setError(message(cause));
        setRefreshToken((token) => token + 1);
      }
      return false;
    } finally {
      mutationBusy.current = false;
      if (version === epoch.current) setBusy(false);
    }
  };
  const loadMore = async () => {
    if (!preferences || !filters || !after || loading || !settled) return;
    const version = queryEpoch.current;
    const connection = epoch.current;
    const key = `${identityKey(environmentId, preferences.hostname, preferences.account)}|${JSON.stringify(filters)}`;
    setLoading(true);
    try {
      const result = await run({
        action: "search",
        account: preferences.account,
        hostname: preferences.hostname,
        filters,
        after,
      });
      if (version !== queryEpoch.current || connection !== epoch.current) return;
      if (result.kind !== "search") throw new Error("Unexpected search response.");
      const merged = [
        ...new Map([...requests, ...result.requests].map((pr) => [pr.id, pr])).values(),
      ].slice(0, 1000);
      const nextAfter = result.pageInfo.hasNextPage ? (result.pageInfo.endCursor ?? null) : null;
      rememberSearch(key, {
        requests: merged,
        count: result.count,
        after: nextAfter,
        at: searchCache.get(key)?.at ?? Date.now(),
      });
      setRequests(merged);
      setAfter(nextAfter);
      setCount(result.count);
      setError(null);
    } catch (cause) {
      if (version === queryEpoch.current && connection === epoch.current) setError(message(cause));
    } finally {
      if (version === queryEpoch.current && connection === epoch.current) setLoading(false);
    }
  };
  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);
  return {
    preferences,
    filters,
    setFilters,
    repositories,
    organizations,
    requests,
    count,
    after,
    connecting,
    discovering,
    busy,
    loading,
    settled,
    error,
    repositoryError,
    connect: reconnect,
    mutate,
    loadMore,
    run,
    refresh,
  };
}
function message(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "GitHub could not complete this request. Retry when connected.";
}
