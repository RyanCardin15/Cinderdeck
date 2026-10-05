import { DECKHAND_METHODS } from "@cinderdeck/contracts/deckhand/rpc";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@cinderdeck/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
export const contextPullRequestsView = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "deckhand:context-pull-requests",
    tag: DECKHAND_METHODS.contextPullRequests,
    idleTtlMs: 0,
  },
);
