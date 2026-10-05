import type { RuntimeMode, ServerProvider } from "@t3tools/contracts";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeUtil from "node:util";

export type CodexRequirements = CodexSchema.V2ConfigRequirementsReadResponse["requirements"];

export const readCodexRequirements = (client: CodexClient.CodexAppServerClient["Service"]) =>
  client.request("configRequirements/read", undefined).pipe(
    Effect.map((response) => response.requirements),
    // Only old servers without the API are treated as having no requirements.
    Effect.catchTags({
      CodexAppServerRequestError: (error) =>
        error.code === -32601 ? Effect.succeed(null) : Effect.fail(error),
    }),
  );

const isCodexRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

const policyError = (detail: string) =>
  new CodexErrors.CodexAppServerRequestError({
    code: -32602,
    errorMessage: `Organization policy: ${detail}`,
  });

const sandboxModes = ["read-only", "workspace-write", "danger-full-access"] as const;
const sandboxTypes = ["readOnly", "workspaceWrite", "dangerFullAccess"] as const;

/** Never widen a sandbox to satisfy a requirement, including observer/helper sessions. */
export function constrainCodexParams<T>(params: T, requirements: CodexRequirements): T {
  if (!requirements || typeof params !== "object" || params === null) return params;
  const result = { ...params } as Record<string, unknown>;
  const approvals = requirements.allowedApprovalPolicies;
  if (
    result.approvalPolicy != null &&
    approvals != null &&
    !approvals.some((allowed) => NodeUtil.isDeepStrictEqual(allowed, result.approvalPolicy))
  ) {
    const replacement =
      (["on-request", "untrusted"] as const).find((candidate) => approvals.includes(candidate)) ??
      approvals[0];
    if (!replacement)
      throw policyError("No compatible approval policy is allowed for this request.");
    result.approvalPolicy = replacement;
  }
  const sandbox = result.sandboxPolicy as { type?: string } | undefined;
  const requested =
    typeof result.sandbox === "string"
      ? result.sandbox
      : sandboxModes[sandboxTypes.findIndex((type) => type === sandbox?.type)];
  const allowed = requirements.allowedSandboxModes;
  if (requested && allowed != null && !allowed.some((mode) => mode === requested)) {
    const rank = sandboxModes.findIndex((mode) => mode === requested);
    const replacement = sandboxModes
      .slice(0, rank + 1)
      .toReversed()
      .find((mode) => allowed.includes(mode));
    if (!replacement)
      throw policyError(
        `The required ${requested} sandbox is not allowed; this request cannot safely run with broader access.`,
      );
    if (result.sandbox !== undefined) result.sandbox = replacement;
    if (sandbox !== undefined)
      result.sandboxPolicy = { type: sandboxTypes[sandboxModes.indexOf(replacement)] };
  }
  return result as T;
}

/** Cover typed and raw thread start/resume/fork and turn requests at one boundary. */
export function withCodexManagedPolicy(
  client: CodexClient.CodexAppServerClient["Service"],
): CodexClient.CodexAppServerClient["Service"] {
  const adjust = <T>(method: string, params: T) =>
    ["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(method)
      ? readCodexRequirements(client).pipe(
          Effect.flatMap((requirements) =>
            Effect.try({
              try: () => constrainCodexParams(params, requirements),
              catch: (error) =>
                isCodexRequestError(error)
                  ? error
                  : policyError("Could not resolve managed access requirements."),
            }),
          ),
        )
      : Effect.succeed(params);
  return {
    ...client,
    request: (method, params) =>
      adjust(method, params).pipe(Effect.flatMap((adjusted) => client.request(method, adjusted))),
    raw: {
      ...client.raw,
      request: (method, params) =>
        adjust(method, params).pipe(
          Effect.flatMap((adjusted) => client.raw.request(method, adjusted)),
        ),
    },
  };
}

export function codexRuntimeModeAdjustments(
  requirements: CodexRequirements,
): NonNullable<ServerProvider["runtimeModeAdjustments"]> {
  const defaults: Record<RuntimeMode, { approvalPolicy: string; sandbox: string }> = {
    "approval-required": { approvalPolicy: "untrusted", sandbox: "read-only" },
    "auto-accept-edits": { approvalPolicy: "on-request", sandbox: "workspace-write" },
    auto: { approvalPolicy: "on-request", sandbox: "workspace-write" },
    "full-access": { approvalPolicy: "never", sandbox: "danger-full-access" },
  };
  return Object.entries(defaults).flatMap(([mode, requested]) => {
    try {
      const effective = constrainCodexParams(requested, requirements);
      return NodeUtil.isDeepStrictEqual(effective, requested)
        ? []
        : [
            {
              mode: mode as RuntimeMode,
              description: `Adjusted by organization policy: ${typeof effective.approvalPolicy === "string" ? effective.approvalPolicy : "custom"} approvals, ${effective.sandbox} sandbox.`,
            },
          ];
    } catch {
      return [
        {
          mode: mode as RuntimeMode,
          description: "Unavailable under organization policy: no compatible access settings.",
        },
      ];
    }
  });
}
