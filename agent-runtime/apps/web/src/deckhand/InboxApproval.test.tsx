// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId, RuntimeRequestId, NodeId } from "@cinderdeck/contracts";
import type { AttentionItem } from "@cinderdeck/contracts/deckhand/attentionRpc";
import * as DateTime from "effect/DateTime";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
  respond: vi.fn(),
  status: "live",
  requestId: "request1",
  capability: "live",
  options: undefined as
    | undefined
    | Array<{ decision: "accept" | "decline"; label: string; warning?: string }>,
}));
vi.mock("../state/entities", () => ({
  useThreadStatus: () => mocks.status,
  useThreadProjection: () => ({
    projection: {
      runtimeRequests: [
        {
          id: RuntimeRequestId.make(mocks.requestId),
          nodeId: NodeId.make("node"),
          kind: "command",
          status: "pending",
          responseCapability: { type: mocks.capability },
          createdAt: DateTime.makeUnsafe("2026-10-06T00:00:00Z"),
        },
      ],
      turnItems: [
        {
          type: "approval_request",
          requestId: RuntimeRequestId.make(mocks.requestId),
          prompt: "Run npm test in /fixture?",
          options: mocks.options,
        },
      ],
    },
  }),
}));
vi.mock("../state/threads", () => ({ threadEnvironment: { respondToApproval: "respond" } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => mocks.respond }));
import { InboxApproval } from "./InboxApproval";
const item: AttentionItem = {
  id: "cause",
  scopeKey: "thread:writer",
  causeVersion: "version",
  kind: "approval",
  title: "Approval needed",
  detail: "Review request",
  severity: "info",
  target: {
    kind: "thread",
    threadId: ThreadId.make("writer"),
    requestId: RuntimeRequestId.make("request1"),
  },
  observedAt: "2026-10-06T00:00:00Z",
  state: "active",
  revision: 1,
  canSnooze: false,
  freshness: "current",
  read: false,
  snoozedUntil: null,
  dispositionRevision: 0,
};
let container: HTMLDivElement;
let root: Root;
const refresh = vi.fn();
const render = (live = true, value = item) =>
  act(async () =>
    root.render(
      <InboxApproval
        item={value}
        environmentId={EnvironmentId.make("remote")}
        live={live}
        onResolved={refresh}
      />,
    ),
  );
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((button) => button.textContent === label)!;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.status = "live";
  mocks.requestId = "request1";
  mocks.capability = "live";
  mocks.options = undefined;
  mocks.respond.mockResolvedValue({ _tag: "Success" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("shows the exact prompt and sends one decision to the originating computer/request", async () => {
  await render();
  expect(container.textContent).toContain("Run npm test in /fixture?");
  await act(async () => {
    button("Approve").click();
    button("Approve").click();
  });
  expect(mocks.respond).toHaveBeenCalledTimes(1);
  expect(mocks.respond).toHaveBeenCalledWith({
    environmentId: "remote",
    input: { threadId: "writer", requestId: "request1", decision: "accept" },
  });
  expect(refresh).toHaveBeenCalledOnce();
  expect(button("Approve").disabled).toBe(true);
});
it("refuses replaced requests, old servers, cached projections and disconnected sources", async () => {
  mocks.requestId = "request2";
  await render();
  expect(container.querySelector("button")).toBeNull();
  mocks.requestId = "request1";
  mocks.status = "cached";
  await render();
  expect(button("Approve").disabled).toBe(true);
  mocks.status = "live";
  await render(false);
  expect(button("Approve").disabled).toBe(true);
  mocks.capability = "not_resumable";
  await render();
  expect(button("Approve").disabled).toBe(true);
  await render(true, { ...item, target: { kind: "thread", threadId: ThreadId.make("writer") } });
  expect(container.querySelector("button")).toBeNull();
  expect(mocks.respond).not.toHaveBeenCalled();
});
it("honors provider choices and warnings and leaves failed decisions retryable", async () => {
  mocks.options = [
    {
      decision: "decline",
      label: "Deny access",
      warning: "Untrusted content requested this action",
    },
  ];
  mocks.respond.mockResolvedValue({ _tag: "Failure" });
  await render();
  expect(button("Approve")).toBeUndefined();
  expect(container.textContent).toContain("Untrusted content");
  await act(async () => button("Deny access").click());
  expect(mocks.respond.mock.calls[0]?.[0].input.decision).toBe("decline");
  expect(container.textContent).toContain("Could not send this decision");
  expect(button("Deny access").disabled).toBe(false);
  expect(refresh).not.toHaveBeenCalled();
});
