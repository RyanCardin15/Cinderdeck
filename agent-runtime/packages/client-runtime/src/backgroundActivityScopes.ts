import { type BackgroundScope, type EnvironmentId, WS_METHODS } from "@cinderdeck/contracts";

import type { EnvironmentRpcSubscriptionObservation } from "./rpc/client.ts";

/** Identity of a retained background scope; equal scopes share one ref count. */
export function stableBackgroundScopeKey(
  environmentId: EnvironmentId,
  scope: BackgroundScope,
): string {
  switch (scope.type) {
    case "server-config":
    case "diagnostics":
      return JSON.stringify([environmentId, scope.type]);
    case "provider-status":
      return JSON.stringify([environmentId, scope.type, scope.instanceId ?? null]);
    case "vcs-status":
    case "git-refs":
      return JSON.stringify([environmentId, scope.type, scope.cwd]);
    case "thread":
      return JSON.stringify([environmentId, scope.type, scope.threadId]);
  }
}

/** The background scope an open RPC subscription keeps alive, if any. */
export function backgroundScopeForSubscription(
  observation: EnvironmentRpcSubscriptionObservation,
): BackgroundScope | null {
  if (observation.method === WS_METHODS.subscribeResourceTelemetry) {
    return { type: "diagnostics" };
  }
  if (observation.method !== WS_METHODS.subscribeVcsStatus) {
    return null;
  }
  const input = observation.input as { readonly cwd?: unknown };
  return typeof input.cwd === "string" ? { type: "vcs-status", cwd: input.cwd } : null;
}
