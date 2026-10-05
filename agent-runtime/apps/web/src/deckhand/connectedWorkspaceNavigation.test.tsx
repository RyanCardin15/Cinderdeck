import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { SessionBindingId } from "@t3tools/contracts/deckhand";
import * as Schema from "effect/Schema";
import { ThreadContextView } from "@t3tools/contracts/deckhand/rpc";
import { expect, it, vi } from "vite-plus/test";
import {
  connectedWorkspaceSearch,
  savedWorkspaceMatches,
  validateWorkspaceSearch,
} from "./workspaceNavigation";
const observed = vi.hoisted(() => ({
  context: null as ThreadContextView | null,
  stale: false,
  links: [] as { to: string; search?: Record<string, unknown> }[],
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    children,
  }: {
    to: string;
    search?: Record<string, unknown>;
    children: ReactNode;
  }) => {
    observed.links.push({ to, ...(search ? { search } : {}) });
    return <a href={to}>{children}</a>;
  },
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: observed.context, error: null }),
}));
vi.mock("./useAgentObservation", () => ({
  useAgentObservation: () => ({ stale: observed.stale, reconnecting: observed.stale }),
}));
vi.mock("./state", () => ({ threadContextView: () => null }));
vi.mock("./RecordingContextSummary", () => ({ RecordingContextSummary: () => null }));
vi.mock("./PreviewCaptureControl", () => ({ PreviewCaptureControl: () => null }));
vi.mock("./ManagedSessionControl", () => ({ ManagedSessionControl: () => null }));
vi.mock("./ReviewerLauncher", () => ({ ReviewerLauncher: () => null }));
vi.mock("./LinkedWorkContext", () => ({ LinkedWorkContext: () => null }));
import { LaneSessionContext } from "./LaneSessionContext";
import { ConnectedLaneSidebar } from "./ConnectedLaneSidebar";
const context = Schema.decodeSync(ThreadContextView)({
  workspace: {
    id: "workspace",
    environmentId: "native-installation",
    backend: "cinderdeck",
    ownerId: "primary-workspace",
    generation: 1,
    revision: 1,
    name: "Payment",
    state: "active",
  },
  checkout: {
    id: "checkout",
    workspaceId: "workspace",
    workspaceGeneration: 1,
    nativeGeneration: 7,
    environmentId: "native-installation",
    backend: "cinderdeck",
    kind: "lane",
    laneId: "review-lane",
    state: "ready",
    repositories: [],
    revision: 1,
  },
  feature: {
    id: "feature",
    workspaceId: "workspace",
    title: "Payment retry feature",
    objective: "Make retries clear",
    status: "active",
    revision: 1,
    createdAt: "2026-10-04T10:00:00Z",
    updatedAt: "2026-10-04T10:00:00Z",
  },
  session: {
    id: "session",
    threadId: "thread",
    providerSessionId: null,
    providerInstanceId: "codex-work",
    featureId: "feature",
    checkoutId: "checkout",
    role: "writer",
    desiredAccess: "write",
    execution: "waiting_approval",
    connection: "connected",
    capabilities: {
      nativeResume: true,
      interrupt: false,
      steering: false,
      approvals: true,
      questions: false,
      enforcedReadOnly: false,
      imageInput: false,
      videoInput: false,
      managed: true,
    },
    lastSequence: 0,
  },
  native: null,
  nativeConnection: "unavailable",
  sessions: [],
});
const threadRef = {
  environmentId: EnvironmentId.make("remote-computer"),
  threadId: ThreadId.make("thread"),
};
const noAction = () => {};
it.each(["lane", "primary"] as const)(
  "all %s context returns pin the original execution computer and native generation",
  (kind) => {
    const current = {
      ...context,
      checkout: { ...context.checkout, kind, laneId: kind === "lane" ? "review-lane" : null },
      sessions: Array.from({ length: 7 }, (_, index) => ({
        binding: {
          ...context.session,
          id: SessionBindingId.make(`session-${index}`),
          threadId: index === 0 ? threadRef.threadId : ThreadId.make(`thread-${index}`),
        },
        title: index === 0 ? "Implement retries" : `Follow-up ${index}`,
        source: "current" as const,
        archived: false,
      })),
    };
    observed.context = current;
    observed.stale = false;
    observed.links = [];
    const header = renderToStaticMarkup(
      <LaneSessionContext
        context={current}
        threadRef={threadRef}
        providers={[]}
        stale={false}
        previewAvailable={false}
        onOpenPreview={noAction}
        onOpenDiff={noAction}
        onOpenTerminal={noAction}
        onOpenSource={noAction}
        onOpenPullRequests={noAction}
        pullRequestsAvailable={false}
        pullRequestCount={0}
      />,
    );
    const sidebar = renderToStaticMarkup(
      <ConnectedLaneSidebar
        threadRef={threadRef}
        providers={[{ instanceId: "codex-work", displayName: "Codex · Work" }]}
      />,
    );
    const returns = observed.links.filter((link) => link.to === "/workspaces");
    expect(returns).toHaveLength(3);
    const expected = connectedWorkspaceSearch(threadRef.environmentId, current);
    for (const link of returns) {
      expect(link.search).toEqual({
        ...expected,
        ...(link.search?.tab ? { tab: link.search.tab } : {}),
      });
      const saved = validateWorkspaceSearch(link.search ?? {});
      expect(savedWorkspaceMatches(saved, "native-installation", 7)).toBe(true);
      expect(savedWorkspaceMatches(saved, "native-installation", 8)).toBe(false);
      expect(savedWorkspaceMatches(saved, "replacement-installation", 7)).toBe(false);
    }
    expect(returns.filter((link) => link.search?.tab === "agents")).toHaveLength(1);
    expect(header).toContain("Manage services in workspace");
    expect(returns.filter((link) => link.search?.tab === "services")).toHaveLength(1);
    expect(sidebar).toContain(kind === "lane" ? "Lane · review-lane" : "Primary checkout");
    expect(sidebar).toContain("Implement retries");
    expect(sidebar).toContain("Codex · Work");
    expect(sidebar).toContain("Needs approval");
  },
);

it("retains scoped conversation links while downgrading disconnected agent observations", () => {
  const current = {
    ...context,
    sessions: [
      {
        binding: context.session,
        title: "Implement retries",
        source: "current" as const,
        archived: false,
      },
    ],
  };
  observed.context = current;
  observed.stale = true;
  observed.links = [];
  const header = renderToStaticMarkup(
    <LaneSessionContext
      context={current}
      threadRef={threadRef}
      providers={[]}
      stale={false}
      previewAvailable={false}
      onOpenPreview={noAction}
      onOpenDiff={noAction}
      onOpenTerminal={noAction}
      onOpenSource={noAction}
      onOpenPullRequests={noAction}
      pullRequestsAvailable={false}
      pullRequestCount={0}
    />,
  );
  const sidebar = renderToStaticMarkup(<ConnectedLaneSidebar threadRef={threadRef} />);
  expect(header).toContain("Current service state is unavailable");
  expect(header).toContain("Saved conversation context");
  expect(header).toContain("Last observed");
  expect(sidebar).toContain("Last observed");
  expect(sidebar).toContain("State unavailable");
  expect(sidebar).not.toContain("Needs approval");
  expect(
    observed.links
      .filter((link) => link.to === "/workspaces")
      .every(
        (link) =>
          link.search?.environment === "remote-computer" && link.search.expectedGeneration === 7,
      ),
  ).toBe(true);
  observed.stale = false;
});
