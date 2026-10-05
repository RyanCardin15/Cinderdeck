import type { CheckoutBinding, SessionBinding } from "@cinderdeck/contracts/deckhand";
const executionLabels: Record<SessionBinding["execution"], string> = {
  queued: "Queued",
  starting: "Starting",
  working: "Working",
  waiting_input: "Needs input",
  waiting_approval: "Needs approval",
  idle: "Idle",
  finished_turn: "Turn complete",
  interrupted: "Interrupted",
  failed: "Failed",
  unknown: "Unknown",
};
export const agentExecutionLabel = (execution: SessionBinding["execution"], unavailable = false) =>
  unavailable ? "State unavailable" : executionLabels[execution];
export const agentProviderLabel = (
  instanceId: string,
  providers: ReadonlyArray<{ readonly instanceId: string; readonly displayName: string }>,
) => providers.find((provider) => provider.instanceId === instanceId)?.displayName ?? instanceId;
export const agentCheckoutLabel = (
  checkout: Pick<CheckoutBinding, "kind" | "laneId">,
  nativeLaneName?: string,
) =>
  checkout.kind === "primary"
    ? "Primary checkout"
    : `Lane · ${nativeLaneName ?? checkout.laneId ?? "Name unavailable"}`;
