import { expect, it } from "vite-plus/test";
import { agentCheckoutLabel, agentExecutionLabel, agentProviderLabel } from "./agentPresentation";
it("keeps primary and lane identity explicit independently of feature or conversation title", () => {
  expect(agentCheckoutLabel({ kind: "primary", laneId: null }, "Ignored lane name")).toBe(
    "Primary checkout",
  );
  expect(agentCheckoutLabel({ kind: "lane", laneId: "saved-lane-id" }, "Payment retry")).toBe(
    "Lane · Payment retry",
  );
  expect(agentCheckoutLabel({ kind: "lane", laneId: "saved-lane-id" })).toBe(
    "Lane · saved-lane-id",
  );
});
it("resolves only the exact configured provider account, retaining unknown IDs honestly", () => {
  const providers = [
    { instanceId: "codex-work", displayName: "Codex · Work" },
    { instanceId: "codex-personal", displayName: "Codex · Personal" },
  ];
  expect(agentProviderLabel("codex-work", providers)).toBe("Codex · Work");
  expect(agentProviderLabel("codex-personal", providers)).toBe("Codex · Personal");
  expect(agentProviderLabel("removed-account", providers)).toBe("removed-account");
});
it("presents actionable status labels and downgrades every unavailable observation", () => {
  expect(agentExecutionLabel("waiting_input")).toBe("Needs input");
  expect(agentExecutionLabel("waiting_approval")).toBe("Needs approval");
  expect(agentExecutionLabel("finished_turn")).toBe("Turn complete");
  expect(agentExecutionLabel("queued")).toBe("Queued");
  expect(agentExecutionLabel("working", true)).toBe("State unavailable");
  expect(agentExecutionLabel("finished_turn", true)).toBe("State unavailable");
});
