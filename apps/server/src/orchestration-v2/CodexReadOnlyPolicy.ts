import type { ProviderAdapterV2RuntimePolicy } from "./ProviderAdapter.ts";

/** Applied from the saved managed observer binding, never from a UI runtime mode. */
export function forceCodexReadOnlyPolicy(
  policy: ProviderAdapterV2RuntimePolicy,
): ProviderAdapterV2RuntimePolicy {
  return { ...policy, approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } };
}

export function isCodexReadOnlyPolicy(policy: ProviderAdapterV2RuntimePolicy | undefined): boolean {
  const sandbox = policy?.sandboxPolicy;
  return (
    policy?.approvalPolicy === "never" &&
    typeof sandbox === "object" &&
    sandbox !== null &&
    "type" in sandbox &&
    sandbox.type === "readOnly"
  );
}
