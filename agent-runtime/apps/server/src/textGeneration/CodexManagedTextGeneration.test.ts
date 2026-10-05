import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as CodexClient from "effect-codex-app-server/client";
import { generateManagedCodexText } from "./CodexManagedTextGeneration.ts";

it.effect("managed metadata uses read-only protocol turns and declines escalation", () =>
  Effect.gen(function* () {
    const notifications = new Map<string, (payload: unknown) => Effect.Effect<void>>();
    const approvals = new Map<string, () => Effect.Effect<unknown>>();
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const client = {
      handleServerRequest: (method: string, handler: () => Effect.Effect<unknown>) =>
        Effect.sync(() => {
          approvals.set(method, handler);
        }),
      handleServerNotification: (
        method: string,
        handler: (payload: unknown) => Effect.Effect<void>,
      ) =>
        Effect.sync(() => {
          notifications.set(method, handler);
        }),
      request: (method: string, params: Record<string, unknown>) =>
        Effect.gen(function* () {
          requests.push({ method, params });
          if (method === "thread/start") return { thread: { id: "metadata" } };
          yield* notifications.get("item/completed")!({
            item: { type: "agentMessage", text: '{"title":"Policy test"}' },
          });
          yield* notifications.get("turn/completed")!({ turn: { status: "completed" } });
          return { turn: { id: "turn" } };
        }),
    } as unknown as CodexClient.CodexAppServerClient["Service"];
    const text = yield* generateManagedCodexText({
      client,
      approvalPolicy: "on-request",
      cwd: "/repo",
      model: "test",
      prompt: "Title",
      imagePaths: [],
      outputSchema: { type: "object" },
      effort: "low",
    });
    assert.equal(text, '{"title":"Policy test"}');
    assert.equal(requests[0]!.params.sandbox, "read-only");
    assert.equal(requests[0]!.params.ephemeral, true);
    assert.equal(requests[1]!.params.approvalPolicy, "on-request");
    assert.deepStrictEqual(requests[1]!.params.sandboxPolicy, { type: "readOnly" });
    assert.deepStrictEqual(yield* approvals.get("item/commandExecution/requestApproval")!(), {
      decision: "decline",
    });
    assert.deepStrictEqual(yield* approvals.get("item/permissions/requestApproval")!(), {
      permissions: {},
      scope: "turn",
    });
  }),
);
