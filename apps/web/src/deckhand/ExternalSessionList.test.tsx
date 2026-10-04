// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId } from "@t3tools/contracts";
import * as C from "@t3tools/contracts/deckhand/externalSessionsRpc";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const commands = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: () => "externalList",
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => commands.list }));
import { ExternalSessionList } from "./ExternalSessionList";
const reported = Schema.decodeSync(C.ExternalSessionView)({
  installationID: "installation",
  workspaceID: "lane",
  generation: 3,
  featureId: "feature",
  checkoutId: "checkout",
  id: "external:11111111-1111-1111-1111-111111111111",
  providerName: "Claude",
  providerSessionId: "claimed-id",
  title: "Reported review",
  role: "reviewer",
  repositoryScope: ["physical"],
  reportedExecution: "working",
  reportedCapabilities: ["read_only", "resume"],
  source: "registrant_reported",
  lastSequence: 1,
  registeredAt: "2026-10-03T00:00:00Z",
  lastSeenAt: "2026-10-03T00:01:00Z",
  expiresAt: "2026-10-03T00:03:00Z",
  archivedAt: null,
  connection: "stale",
  leaseSeconds: 120,
  control: {
    transcript: false,
    interrupt: false,
    resume: false,
    approvals: false,
    writerReservation: false,
  },
});
let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
  commands.list.mockReset();
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.useRealTimers();
});
const render = async (generation = 3) =>
  act(async () =>
    root.render(
      <ExternalSessionList
        environmentId={EnvironmentId.make("computer")}
        installationID="installation"
        workspaceID="lane"
        generation={generation}
      />,
    ),
  );
it("shows stale external claims without managed navigation or controls", async () => {
  commands.list.mockResolvedValue({ _tag: "Success", value: [reported] });
  await render();
  expect(element.textContent).toContain("Last reported: working");
  expect(element.textContent).toContain("Connection lost / last seen");
  expect(element.textContent).toContain("do not grant Deckhand controls");
  expect(element.querySelectorAll("button,a")).toHaveLength(0);
  expect(commands.list).toHaveBeenCalledWith({
    environmentId: "computer",
    input: { installationID: "installation", workspaceID: "lane", generation: 3, limit: 20 },
  });
});
it("preserves last observed rows on refresh failure and clears them when selected generation changes", async () => {
  vi.useFakeTimers();
  commands.list
    .mockResolvedValueOnce({ _tag: "Success", value: [reported] })
    .mockResolvedValue({ _tag: "Failure" });
  await render();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(element.textContent).toContain("Retained rows show only the last observed report");
  expect(element.textContent).toContain("Reported review");
  await render(4);
  expect(element.textContent).not.toContain("Reported review");
  expect(element.textContent).toContain("unavailable");
});
