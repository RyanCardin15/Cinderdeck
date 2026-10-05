import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as CodexErrors from "effect-codex-app-server/errors";

/** codex exec forces `never` on some versions. Use the protocol for managed helpers. */
export const generateManagedCodexText = (input: {
  client: CodexClient.CodexAppServerClient["Service"];
  approvalPolicy: CodexSchema.V2TurnStartParams__AskForApproval;
  cwd: string;
  model: string;
  prompt: string;
  imagePaths: ReadonlyArray<string>;
  outputSchema: NonNullable<CodexSchema.V2TurnStartParams["outputSchema"]>;
  effort: string;
}) =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<string, CodexErrors.CodexAppServerRequestError>();
    let text = "";
    const { client } = input;
    yield* client.handleServerRequest("item/commandExecution/requestApproval", () =>
      Effect.succeed({ decision: "decline" }),
    );
    yield* client.handleServerRequest("item/fileChange/requestApproval", () =>
      Effect.succeed({ decision: "decline" }),
    );
    yield* client.handleServerRequest("item/permissions/requestApproval", () =>
      Effect.succeed({ permissions: {}, scope: "turn" }),
    );
    yield* client.handleServerNotification("item/completed", ({ item }) =>
      Effect.sync(() => {
        if (item.type === "agentMessage") text = item.text;
      }),
    );
    yield* client.handleServerNotification("turn/completed", ({ turn }) =>
      turn.status === "completed"
        ? Deferred.succeed(done, text).pipe(Effect.asVoid)
        : Deferred.fail(
            done,
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: turn.error?.message ?? `Codex helper ${turn.status}.`,
            }),
          ).pipe(Effect.asVoid),
    );
    const thread = yield* client.request("thread/start", {
      cwd: input.cwd,
      model: input.model,
      ephemeral: true,
      approvalPolicy: input.approvalPolicy,
      sandbox: "read-only",
      config: { model_reasoning_effort: input.effort },
    });
    yield* client.request("turn/start", {
      threadId: thread.thread.id,
      approvalPolicy: input.approvalPolicy,
      sandboxPolicy: { type: "readOnly" },
      input: [
        { type: "text", text: input.prompt, text_elements: [] },
        ...input.imagePaths.map((path) => ({ type: "localImage" as const, path })),
      ],
      outputSchema: input.outputSchema,
    });
    return yield* Deferred.await(done);
  });
