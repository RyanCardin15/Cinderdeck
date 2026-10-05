import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexClient from "effect-codex-app-server/client";
import {
  codexRuntimeModeAdjustments,
  constrainCodexParams,
  withCodexManagedPolicy,
  readCodexRequirements,
} from "./CodexManagedPolicy.ts";

const requirements = {
  allowedApprovalPolicies: ["on-request", "untrusted"] as const,
  allowedSandboxModes: ["read-only", "workspace-write"] as const,
};
it("adjusts full access while preserving allowed settings and caller data", () => {
  const original = {
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
    model: "test",
  };
  assert.deepStrictEqual(constrainCodexParams(original, requirements), {
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "workspaceWrite" },
    model: "test",
  });
  assert.equal(original.approvalPolicy, "never");
  const scoped = {
    approvalPolicy: "untrusted",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/repo"], networkAccess: false },
  };
  assert.deepStrictEqual(constrainCodexParams(scoped, requirements), scoped);
  assert.deepStrictEqual(constrainCodexParams(original, null), original);
});
it("keeps read-only helpers read-only and refuses incompatible requirements", () => {
  assert.deepStrictEqual(
    constrainCodexParams({ approvalPolicy: "never", sandbox: "read-only" }, requirements),
    { approvalPolicy: "on-request", sandbox: "read-only" },
  );
  assert.throws(
    () =>
      constrainCodexParams({ sandbox: "read-only" }, { allowedSandboxModes: ["workspace-write"] }),
    /cannot safely run/,
  );
  assert.throws(
    () => constrainCodexParams({ approvalPolicy: "never" }, { allowedApprovalPolicies: [] }),
    /No compatible approval/,
  );
});
it("reports adjusted modes and resets when restrictions disappear", () => {
  assert.deepStrictEqual(
    codexRuntimeModeAdjustments(requirements).map((entry) => entry.mode),
    ["full-access"],
  );
  assert.deepStrictEqual(codexRuntimeModeAdjustments(null), []);
});
it.effect("constrains typed and raw lifecycle requests before sending", () =>
  Effect.gen(function* () {
    const requests: Array<{ method: string; params: unknown }> = [];
    const native = {
      request: (method: string, params: unknown) =>
        Effect.sync(() => {
          if (method === "configRequirements/read") return { requirements };
          requests.push({ method, params });
          return {};
        }),
      raw: {
        request: (method: string, params: unknown) =>
          Effect.sync(() => {
            requests.push({ method, params });
            return {};
          }),
      },
    } as unknown as CodexClient.CodexAppServerClient["Service"];
    const client = withCodexManagedPolicy(native);
    yield* client.request("thread/start", { approvalPolicy: "never", sandbox: "read-only" });
    for (const method of ["thread/resume", "thread/fork"] as const) {
      yield* client.request(method, {
        threadId: "test",
        approvalPolicy: "never",
        sandbox: "read-only",
      });
      yield* client.raw.request(method, {
        threadId: "test",
        approvalPolicy: "never",
        sandbox: "read-only",
      });
    }
    yield* client.request("turn/start", {
      threadId: "test",
      input: [],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    assert.equal(requests.length, 6);
    for (const request of requests)
      assert.equal((request.params as { approvalPolicy: string }).approvalPolicy, "on-request");
  }),
);
it.effect("only method-not-found permits a requirements fallback", () =>
  Effect.gen(function* () {
    const client = (code: number) =>
      ({
        request: () =>
          Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code,
              errorMessage: "requirements unavailable",
            }),
          ),
      }) as unknown as CodexClient.CodexAppServerClient["Service"];
    assert.isNull(yield* readCodexRequirements(client(-32601)));
    const result = yield* readCodexRequirements(client(-32603)).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
  }),
);

it("accepts granular-only managed approval policies", () => {
  const granular = { granular: { sandbox_approval: true, rules: true, mcp_elicitations: true } };
  const requirements = { allowedApprovalPolicies: [granular] };
  assert.deepStrictEqual(
    constrainCodexParams({ approvalPolicy: "never" }, requirements).approvalPolicy as unknown,
    granular,
  );
  assert.include(codexRuntimeModeAdjustments(requirements)[0]!.description, "custom approvals");
});
