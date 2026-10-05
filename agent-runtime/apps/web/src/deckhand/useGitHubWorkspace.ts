import { useCallback, useEffect, useRef, useState } from "react";
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
  const [discovering, setDiscovering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repositoryError, setRepositoryError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const epoch = useRef(0);
  const queryEpoch = useRef(0);
  const mutationBusy = useRef(false);
  const serial = useRef<Promise<unknown>>(Promise.resolve());
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
    (input: GitHubWorkspaceInput, current?: () => boolean) => {
      const version = epoch.current;
      const next = serial.current
        .catch(() => undefined)
        .then(() => {
          if (version !== epoch.current || (current && !current()))
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
  useEffect(() => {
    if (connected) void connect();
    return () => {
      ++epoch.current;
      ++queryEpoch.current;
    };
  }, [connect, connected]);
  useEffect(() => {
    const onFocus = () => {
      if (connected && !mutationBusy.current) void connect();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [connect, connected]);
  const account = preferences?.account;
  const hostname = preferences?.hostname;
  const organization = filters?.organization;
  useEffect(() => {
    if (!account || !hostname) return;
    let cancelled = false;
    setDiscovering(true);
    setRepositoryError(null);
    const identity = { account, hostname };
    const load = async (action: "repositories" | "organizations") => {
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const result: GitHubWorkspaceResult =
          action === "repositories"
            ? await run({ action, ...identity, organization: organization ?? null, after: cursor })
            : await run({ action, ...identity, after: cursor });
        if (cancelled) return;
        if (result.kind === "repositories") {
          setRepositories((existing) => [
            ...new Map([...existing, ...result.page.nodes].map((repo) => [repo.id, repo])).values(),
          ]);
        } else if (result.kind === "organizations") {
          setOrganizations((existing) =>
            [...new Set([...existing, ...result.page.nodes.map((org) => org.login)])].sort(),
          );
        } else throw new Error("Unexpected repository response.");
        const info: { hasNextPage: boolean; endCursor?: string | null } | undefined =
          result.page.pageInfo;
        cursor = info?.hasNextPage ? (info.endCursor ?? null) : null;
        if (info?.hasNextPage && (!cursor || seen.has(cursor)))
          throw new Error("Repository pagination changed. Reconnect to retry.");
        if (cursor) seen.add(cursor);
      } while (cursor);
    };
    void Promise.allSettled([load("repositories"), load("organizations")]).then((results) => {
      if (cancelled) return;
      const failed = results.find((result) => result.status === "rejected");
      setRepositoryError(failed?.status === "rejected" ? message(failed.reason) : null);
      setDiscovering(false);
    });
    return () => {
      cancelled = true;
    };
  }, [account, hostname, organization, run]);
  useEffect(() => {
    if (!preferences || !filters) return;
    const version = ++queryEpoch.current;
    const connection = epoch.current;
    let cancelled = false;
    setRequests([]);
    setAfter(null);
    setCount(0);
    setLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          if (JSON.stringify(filters) !== JSON.stringify(preferences.filters))
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
          if (cancelled || epoch.current !== connection) return;
          const result = await run({
            action: "search",
            account: preferences.account,
            hostname: preferences.hostname,
            filters,
          });
          if (cancelled || version !== queryEpoch.current || epoch.current !== connection) return;
          if (result.kind !== "search") throw new Error("Unexpected search response.");
          setRequests(result.requests);
          setCount(result.count);
          setAfter(result.pageInfo.hasNextPage ? (result.pageInfo.endCursor ?? null) : null);
          setError(null);
        } catch (cause) {
          if (!cancelled && epoch.current === connection && version === queryEpoch.current)
            setError(message(cause));
        } finally {
          if (!cancelled && epoch.current === connection && version === queryEpoch.current)
            setLoading(false);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [preferences, filters, refreshToken, run, write]);
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
      } else if (result.kind === "star")
        setRepositories((repos) =>
          repos.map((repo) =>
            repo.id === result.repositoryID ? { ...repo, viewerHasStarred: result.starred } : repo,
          ),
        );
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
    if (!preferences || !filters || !after || loading) return;
    const version = queryEpoch.current;
    const connection = epoch.current;
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
      setRequests((existing) =>
        [...new Map([...existing, ...result.requests].map((pr) => [pr.id, pr])).values()].slice(
          0,
          1000,
        ),
      );
      setAfter(result.pageInfo.hasNextPage ? (result.pageInfo.endCursor ?? null) : null);
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
    error,
    repositoryError,
    connect,
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
