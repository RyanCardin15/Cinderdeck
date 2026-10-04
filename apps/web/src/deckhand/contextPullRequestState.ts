import { DECKHAND_METHODS } from "@t3tools/contracts/deckhand/rpc";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const contextPullRequestsView = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "deckhand:context-pull-requests",
    tag: DECKHAND_METHODS.contextPullRequests,
    idleTtlMs: 0,
  },
);
