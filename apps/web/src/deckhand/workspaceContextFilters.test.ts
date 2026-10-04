import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { SessionBinding } from "@t3tools/contracts/deckhand";
import type {
  IntegrationView,
  ManagedContextView,
  ManagedSessionView,
} from "@t3tools/contracts/deckhand/rpc";
import {
  defaultWorkspaceFilters,
  selectWorkspaceContexts,
  type WorkspaceResource,
} from "./workspaceContextFilters";
const resource = (id: string): WorkspaceResource => ({
  workspaceID: id,
  generation: 1,
  available: true,
  revision: "r1",
  workspace: {
    id,
    name: `Workspace ${id}`,
    file: `/fixture/${id}`,
    state: "stopped",
    definitionChanged: false,
    issues: [],
    services: [],
    repos: [
      {
        id: "app",
        path: `/fixture/${id}`,
        branch: `fix/${id}`,
        dirty: false,
        changedFiles: 0,
        ahead: 0,
        behind: 0,
      },
    ],
    lane: {
      sourceStackID: "base",
      name: id,
      createdAt: "2026-10-04T00:00:00Z",
      directory: `/fixture/${id}`,
      ports: {},
    },
  },
});
const decodeSession = Schema.decodeSync(SessionBinding);
const session = (
  execution: SessionBinding["execution"] = "working",
  provider = "codex-work",
): ManagedSessionView => ({
  binding: decodeSession({
    id: "s1",
    threadId: "t1",
    providerSessionId: "p1",
    providerInstanceId: provider,
    featureId: "f1",
    checkoutId: "c1",
    role: "writer",
    desiredAccess: "write",
    execution,
    connection: "connected",
    capabilities: {
      nativeResume: true,
      interrupt: true,
      steering: true,
      approvals: true,
      questions: true,
      enforcedReadOnly: false,
      imageInput: true,
      videoInput: false,
      managed: true,
    },
    lastSequence: 1,
  }),
  title: "Payment recovery",
  objective: "Prevent duplicate retries",
  source: "current",
  archived: false,
});
const summary = (
  id: string,
  sessions: ReadonlyArray<ManagedSessionView> = [],
  total = sessions.length,
): ManagedContextView => ({ workspaceID: id, generation: 1, total, sessions });
const options = {
  nativeUnavailable: false,
  agentsUnavailable: false,
  providers: [
    { instanceId: "codex-work", displayName: "Codex · Work" },
    { instanceId: "codex-personal", displayName: "Codex · Personal" },
  ],
};
const contexts = [resource("payments"), resource("account"), resource("history")];
const summaries = [
  summary("payments", [session()]),
  summary("account", [session("idle", "codex-personal")]),
  summary("history", [{ ...session("finished_turn"), archived: true }]),
];
it("combines scoped provider, branch and task search without confusing same-provider accounts", () => {
  const result = selectWorkspaceContexts(
    contexts,
    summaries,
    { ...defaultWorkspaceFilters, search: "fix/payments work payment", provider: "codex-work" },
    options,
  );
  expect(result.resources.map((item) => item.workspaceID)).toEqual(["payments"]);
  expect(result.matchedCount).toBe(1);
  expect(
    selectWorkspaceContexts(
      contexts,
      summaries,
      { ...defaultWorkspaceFilters, provider: "codex-personal" },
      options,
    ).resources.map((item) => item.workspaceID),
  ).toEqual(["account"]);
});
it("distinguishes current active agents from archived contributors and genuinely quiet contexts", () => {
  expect(
    selectWorkspaceContexts(
      contexts,
      summaries,
      { ...defaultWorkspaceFilters, activity: "active" },
      options,
    ).resources.map((item) => item.workspaceID),
  ).toEqual(["payments"]);
  expect(
    selectWorkspaceContexts(
      contexts,
      summaries,
      { ...defaultWorkspaceFilters, activity: "history" },
      options,
    ).resources.map((item) => item.workspaceID),
  ).toEqual(["history"]);
  expect(
    selectWorkspaceContexts(
      contexts,
      summaries,
      { ...defaultWorkspaceFilters, activity: "quiet" },
      options,
    ).resources.map((item) => item.workspaceID),
  ).toEqual(["account", "history"]);
});
it("keeps truncated or unavailable summaries visible instead of inventing no matching provider or quiet state", () => {
  const partial = [
    summary("payments", [session("idle")], 8),
    summary("account", [{ ...session("idle"), source: "unavailable" }]),
  ];
  const result = selectWorkspaceContexts(
    contexts,
    partial,
    { ...defaultWorkspaceFilters, activity: "active" },
    options,
  );
  expect(result.matchedCount).toBe(0);
  expect(result.uncertainCount).toBe(3);
  expect(result.resources).toHaveLength(3);
  const provider = selectWorkspaceContexts(
    contexts,
    partial,
    { ...defaultWorkspaceFilters, provider: "claude-unloaded" },
    options,
  );
  expect(provider.resources.map((item) => item.workspaceID)).toEqual(["payments", "history"]);
});
it("never borrows a summary from another generation", () => {
  const result = selectWorkspaceContexts(
    [resource("payments")],
    [{ ...summary("payments", [session()]), generation: 2 }],
    { ...defaultWorkspaceFilters, activity: "active" },
    options,
  );
  expect(result.matchedCount).toBe(0);
  expect(result.uncertainCount).toBe(1);
});
it("filters actual lifecycle and attention evidence without assuming a primary checkout is running", () => {
  const failedBase = resource("failed");
  const failed = {
    ...failedBase,
    workspace: { ...failedBase.workspace!, issues: ["Missing definition"] },
  };
  const missing = { ...resource("missing"), available: false };
  const runningBase = resource("running");
  const running = { ...runningBase, workspace: { ...runningBase.workspace!, state: "running" } };
  const rows = [resource("stopped"), running, failed, missing];
  const states = rows.map((row) => summary(row.workspaceID));
  expect(
    selectWorkspaceContexts(
      rows,
      states,
      { ...defaultWorkspaceFilters, lifecycle: "state:running" },
      options,
    ).resources,
  ).toEqual([running]);
  expect(
    selectWorkspaceContexts(
      rows,
      states,
      { ...defaultWorkspaceFilters, activity: "attention" },
      options,
    ).resources.map((item) => item.workspaceID),
  ).toEqual(["failed", "missing"]);
  expect(
    selectWorkspaceContexts(
      rows,
      states,
      { ...defaultWorkspaceFilters, lifecycle: "unavailable" },
      options,
    ).resources,
  ).toEqual([missing]);
});
it("retains uncertain activity on disconnect even when cached summaries previously looked quiet", () => {
  const result = selectWorkspaceContexts(
    contexts,
    summaries,
    { ...defaultWorkspaceFilters, activity: "active" },
    { ...options, agentsUnavailable: true },
  );
  expect(result.matchedCount).toBe(0);
  expect(result.uncertainCount).toBe(3);
  expect(
    selectWorkspaceContexts(
      contexts,
      summaries,
      { ...defaultWorkspaceFilters, lifecycle: "state:running" },
      { ...options, nativeUnavailable: true },
    ).uncertainCount,
  ).toBe(3);
});
it("sorts only loaded exact-generation observed activity, leaving unknown dates last without changing input", () => {
  const activity: IntegrationView["activity"] = [
    {
      eventID: "old",
      sourceID: "native",
      sequence: 1,
      workspaceID: "payments",
      generation: 1,
      kind: "workspace.updated",
      observedAt: "2026-10-04T00:00:00Z",
    },
    {
      eventID: "new",
      sourceID: "native",
      sequence: 2,
      workspaceID: "account",
      generation: 1,
      kind: "workspace.updated",
      observedAt: "2026-10-04T01:00:00Z",
    },
    {
      eventID: "wrong-generation",
      sourceID: "native",
      sequence: 3,
      workspaceID: "history",
      generation: 2,
      kind: "workspace.updated",
      observedAt: "2026-10-04T02:00:00Z",
    },
  ];
  const result = selectWorkspaceContexts(
    contexts,
    summaries,
    { ...defaultWorkspaceFilters, sort: "activity" },
    { ...options, activity },
  );
  expect(result.resources.map((item) => item.workspaceID)).toEqual([
    "account",
    "payments",
    "history",
  ]);
  expect(contexts.map((item) => item.workspaceID)).toEqual(["payments", "account", "history"]);
});

it("does not claim a context is quiet when external-agent execution is only reported", () => {
  const reported = {
    ...summary("payments"),
    externalSessions: {
      workspaceID: "payments",
      generation: 1,
      activeCount: 1,
      staleCount: 0,
      lastSeenAt: "2026-10-04T00:00:00Z",
      unavailable: false,
    },
  };
  const result = selectWorkspaceContexts(
    [contexts[0]!],
    [reported],
    { ...defaultWorkspaceFilters, activity: "quiet" },
    options,
  );
  expect(result.matchedCount).toBe(0);
  expect(result.uncertainCount).toBe(1);
});

it("does not exclude a disconnected lane by provider using a complete cached zero or different-provider summary", () => {
  const rows = contexts.slice(0, 2);
  const cached = [summary("payments", [session("idle", "codex-work")]), summary("account")];
  const filters = { ...defaultWorkspaceFilters, provider: "claude-work" };
  expect(selectWorkspaceContexts(rows, cached, filters, options).resources).toHaveLength(0);
  const stale = selectWorkspaceContexts(rows, cached, filters, {
    ...options,
    agentsUnavailable: true,
  });
  expect(stale.resources.map((item) => item.workspaceID)).toEqual(["payments", "account"]);
  expect(stale.matchedCount).toBe(0);
  expect(stale.uncertainCount).toBe(2);
});

it("keeps text no-matches uncertain when complete cached agent or native details become unavailable", () => {
  const rows = contexts.slice(0, 2);
  const cached = [summary("payments", [session("idle")]), summary("account")];
  const filters = { ...defaultWorkspaceFilters, search: "newly added task or branch" };
  expect(selectWorkspaceContexts(rows, cached, filters, options).resources).toHaveLength(0);
  for (const unavailable of [
    { ...options, agentsUnavailable: true },
    { ...options, nativeUnavailable: true },
  ]) {
    const result = selectWorkspaceContexts(rows, cached, filters, unavailable);
    expect(result.resources).toHaveLength(2);
    expect(result.matchedCount).toBe(0);
    expect(result.uncertainCount).toBe(2);
  }
});
