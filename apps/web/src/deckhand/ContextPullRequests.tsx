import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import type { ContextPullRequest } from "@t3tools/contracts/deckhand/rpc";
import { SidebarInset } from "../components/ui/sidebar";
import { Button } from "../components/ui/button";
import { PullRequestDetailPanel } from "../components/pullRequest/PullRequestDetailPanel";
import { usePullRequestList } from "../state/pullRequests";
import { useEnvironment } from "../state/environments";
import { isElectron } from "../env";
import { useAgentObservation } from "./useAgentObservation";
import { workspaceView } from "./state";
import { overviewResources } from "./workspaceNavigation";
import { contextPullRequestsView } from "./contextPullRequestState";
import {
  contextPullRequestReturn,
  contextPullRequestNavigation,
  contextPullRequestSelection,
  contextPullRequestState,
  contextPullRequestTargets,
  contextPullRequestKey,
  contextPullRequestReference,
  type ConnectedPullRequestSearch,
} from "./contextPullRequestScope";
import styles from "./contextPullRequests.module.css";
export function ContextPullRequests({ scope }: { scope: ConnectedPullRequestSearch }) {
  const key = JSON.stringify([
    scope.environmentId,
    scope.deckhandWorkspace,
    scope.deckhandContext,
    scope.deckhandInstallationID,
    scope.deckhandGeneration,
  ]);
  return <ScopedContextPullRequests key={key} scope={scope} />;
}
function ScopedContextPullRequests({ scope }: { scope: ConnectedPullRequestSearch }) {
  const offset = scope.deckhandOffset ?? 0;
  const navigate = useNavigate({ from: "/pull-requests" });
  const go = (nextOffset: number, item?: ContextPullRequest) =>
    void navigate({ search: contextPullRequestNavigation(scope, nextOffset, item), replace: true });
  const environment = useEnvironment(scope.environmentId);
  const nativeResult = useAtomValue(
    workspaceView({
      environmentId: scope.environmentId,
      input: {
        offset: 0,
        limit: 1,
        selectedWorkspaceID: scope.deckhandWorkspace,
        selectedContextID: scope.deckhandContext,
      },
    }),
  );
  const result = useAtomValue(
    contextPullRequestsView({
      environmentId: scope.environmentId,
      input: {
        installationID: scope.deckhandInstallationID,
        workspaceID: scope.deckhandContext,
        generation: scope.deckhandGeneration,
        offset,
        limit: 50,
      },
    }),
  );
  const view = Option.getOrNull(AsyncResult.value(nativeResult));
  const page = Option.getOrNull(AsyncResult.value(result));
  const nativeObservation = useAgentObservation(
    scope.environmentId,
    `${scope.deckhandInstallationID}:${scope.deckhandContext}:${scope.deckhandGeneration}:native`,
    view,
  );
  const pageObservation = useAgentObservation(
    scope.environmentId,
    `${scope.deckhandInstallationID}:${scope.deckhandContext}:${scope.deckhandGeneration}:${offset}:links`,
    page,
  );
  const state = contextPullRequestState(
    scope,
    view,
    page,
    nativeResult._tag === "Failure" ||
      result._tag === "Failure" ||
      environment === null ||
      environment.connection.phase !== "connected" ||
      nativeObservation.stale ||
      pageObservation.stale,
  );
  const items = state === "ready" ? (page?.items ?? []) : [];
  const targets = useMemo(
    () => contextPullRequestTargets(scope.environmentId, items),
    [scope.environmentId, items],
  );
  const host = usePullRequestList(targets);
  const live = useMemo(
    () => new Map((host.data?.entries ?? []).map((item) => [contextPullRequestKey(item), item])),
    [host.data],
  );
  const resource = overviewResources(view).find(
    (item) => item.workspaceID === scope.deckhandContext,
  );
  const selectedCurrent = state === "ready" ? contextPullRequestSelection(scope, items) : null;
  const label = resource?.workspace?.lane?.name ?? "Primary checkout";
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <div className={styles.page}>
        <header className={styles.header}>
          <Link to="/workspaces" search={contextPullRequestReturn(scope)}>
            ← Back to {scope.deckhandTab === "agents" ? "agents" : "workspace"}
          </Link>
          <div>
            <span>
              {resource?.workspace?.name ?? "Saved workspace"} · {label}
            </span>
            <h1>Pull requests</h1>
          </div>
          <p>Pull requests linked to this context’s conversations, across its repositories.</p>
        </header>
        {state !== "ready" ? (
          <section className={styles.message} role="status">
            <h2>
              {state === "loading"
                ? "Loading this context’s pull requests"
                : state === "changed"
                  ? "Saved context changed"
                  : "Context unavailable"}
            </h2>
            <p>
              {state === "loading"
                ? "Checking the saved workspace and reading its links."
                : state === "changed"
                  ? "This workspace or lane no longer matches the saved installation and generation. Return to the workspace and select a current context."
                  : "Reconnect this execution computer and Cinderdeck to inspect these pull requests. The saved context has been retained."}
            </p>
          </section>
        ) : (
          <div className={styles.body}>
            <section className={styles.list} aria-label="Pull requests in selected context">
              <p className={styles.count}>
                {page?.total ?? 0} linked pull request{page?.total === 1 ? "" : "s"}
              </p>
              {host.error ? (
                <p role="status">
                  Current hosting status is unavailable. Saved links remain available.
                </p>
              ) : null}
              {!items.length ? (
                <p>No pull requests are linked to this context’s conversations.</p>
              ) : null}
              {items.map((item) => {
                const key = contextPullRequestKey(item.link);
                const observed = live.get(key);
                const snapshot = item.link.snapshot;
                return (
                  <button
                    type="button"
                    key={key}
                    className={styles.row}
                    aria-pressed={
                      selectedCurrent ? contextPullRequestKey(selectedCurrent.link) === key : false
                    }
                    onClick={() => go(offset, item)}
                  >
                    <span>
                      {item.link.host} · {item.link.repository} #{item.link.number}
                    </span>
                    <strong>
                      {observed?.title ?? snapshot?.title ?? `Pull request #${item.link.number}`}
                    </strong>
                    <span>
                      {observed?.state ?? snapshot?.state ?? "Status unknown"}
                      {(observed?.isDraft ?? snapshot?.isDraft) ? " · Draft" : ""}
                    </span>
                    <small>
                      {observed?.observedAt
                        ? `Observed ${new Date(observed.observedAt).toLocaleString()}`
                        : snapshot?.syncedAt
                          ? `Last synced ${new Date(snapshot.syncedAt).toLocaleString()}`
                          : "Hosting status has not been observed"}
                    </small>
                  </button>
                );
              })}
              {offset > 0 || page?.nextOffset !== null ? (
                <nav className={styles.paging} aria-label="Context pull request pages">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!offset}
                    onClick={() => go(Math.max(0, offset - 50))}
                  >
                    Previous
                  </Button>
                  <span>
                    {items.length ? `${offset + 1}–${offset + items.length}` : "0"} of{" "}
                    {page?.total ?? 0}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page?.nextOffset == null}
                    onClick={() => go(page?.nextOffset ?? offset)}
                  >
                    Next
                  </Button>
                </nav>
              ) : null}
            </section>
            <section className={styles.detail} aria-label="Selected pull request">
              {selectedCurrent ? (
                <PullRequestDetailPanel
                  key={contextPullRequestKey(selectedCurrent.link)}
                  presentation="deckhand"
                  environmentId={scope.environmentId}
                  reference={contextPullRequestReference(selectedCurrent)}
                  threadRef={{
                    environmentId: scope.environmentId,
                    threadId: selectedCurrent.threadId,
                  }}
                  listEntry={live.get(contextPullRequestKey(selectedCurrent.link)) ?? null}
                  shortcutsEnabled
                  getShortcutContext={() => ({
                    terminalFocus: false,
                    terminalOpen: false,
                    previewFocus: false,
                    previewOpen: false,
                    isWeb: !isElectron,
                    isDesktop: isElectron,
                  })}
                  onClose={() => go(offset)}
                  onActed={() => host.refresh()}
                  onSelectPullRequest={(reference) => {
                    const linked = items.find(
                      (item) =>
                        contextPullRequestKey(item.link) ===
                        contextPullRequestKey({
                          host: reference.host ?? "",
                          repository: reference.repository,
                          number: reference.number,
                        }),
                    );
                    if (linked) go(offset, linked);
                  }}
                />
              ) : (
                <div className={styles.message}>
                  <h2>
                    {scope.number === undefined
                      ? "Choose a pull request"
                      : "Saved pull request unavailable"}
                  </h2>
                  <p>
                    {scope.number === undefined
                      ? "Inspect its changes, review and recorded verification in this context."
                      : "That saved pull request is no longer linked on this page. Choose a current link from the list."}
                  </p>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </SidebarInset>
  );
}
