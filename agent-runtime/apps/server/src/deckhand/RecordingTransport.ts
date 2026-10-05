// @effect-diagnostics nodeBuiltinImport:off - Same-host bounded native recording transport.
import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Contracts from "@cinderdeck/contracts/deckhand/recordingsRpc";
import * as IntegrationDiscovery from "./IntegrationDiscovery.ts";
import * as CinderdeckClient from "./CinderdeckClient.ts";
export class RecordingTransport extends Context.Service<
  RecordingTransport,
  {
    readonly request: (
      actorID: string,
      method: string,
      params: { readonly installationID: string } & Record<string, unknown>,
    ) => Effect.Effect<unknown, Contracts.RecordingError>;
  }
>()("@cinderdeck/server/deckhand/RecordingTransport") {}
const isRecordingError = Schema.is(Contracts.RecordingError);
export const layer = Layer.effect(
  RecordingTransport,
  Effect.gen(function* () {
    const discovery = yield* IntegrationDiscovery.IntegrationDiscovery;
    const client = yield* CinderdeckClient.CinderdeckClient;
    const request: RecordingTransport["Service"]["request"] = (actorID, method, params) =>
      Effect.gen(function* () {
        const target = yield* discovery.locate;
        const connection = yield* client.connect(target.socketPath, {
          channel: target.channel,
          executionHostID: target.hostID,
          installationID: params.installationID,
          clientID: actorID,
        });
        const capability = method.startsWith("integration.build.")
          ? "builds.declared"
          : method === "integration.runs.get"
            ? "runs.detail"
            : method === "integration.runs.failures"
              ? "runs.failures"
              : method.startsWith("integration.recording.")
                ? "recordings.library"
                : method.startsWith("integration.runs.")
                  ? "runs.library"
                  : method.startsWith("integration.linked-work.")
                    ? "linked-work.projection"
                    : null;
        if (!capability || !connection.hello.capabilities.includes(capability))
          return yield* new Contracts.RecordingError({
            reason: "unsupported",
            ...(capability ? { code: capability } : {}),
          });
        return yield* Effect.tryPromise({
          try: (signal) =>
            new Promise<unknown>((resolve, reject) => {
              const socket = NodeNet.createConnection(target.socketPath);
              let finished = false;
              let size = 0;
              const chunks: Buffer[] = [];
              const done = (error?: unknown, value?: unknown) => {
                if (finished) return;
                finished = true;
                signal.removeEventListener("abort", abort);
                socket.destroy();
                if (error) reject(error);
                else resolve(value);
              };
              const abort = () => done(new Contracts.RecordingError({ reason: "cancelled" }));
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) {
                abort();
                return;
              }
              socket.on("error", () =>
                done(new Contracts.RecordingError({ reason: "unavailable" })),
              );
              socket.on("end", () =>
                done(new Contracts.RecordingError({ reason: "invalid_response" })),
              );
              socket.on("connect", () =>
                socket.write(
                  JSON.stringify({
                    id: 1,
                    method,
                    params,
                    client: { name: "Cinderdeck", session: actorID },
                  }) + "\n",
                ),
              );
              socket.on("data", (chunk) => {
                size += chunk.length;
                if (size > 4 * 1024 * 1024) {
                  done(new Contracts.RecordingError({ reason: "response_too_large" }));
                  return;
                }
                const end = chunk.indexOf(10);
                chunks.push(end < 0 ? chunk : chunk.subarray(0, end));
                if (end < 0) return;
                try {
                  const reply = JSON.parse(
                    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
                  ) as { id?: unknown; error?: { code?: unknown }; result?: unknown };
                  if (reply.id !== 1 || (reply.error !== undefined && reply.result !== undefined)) {
                    done(new Contracts.RecordingError({ reason: "invalid_response" }));
                    return;
                  }
                  if (reply.error) {
                    done(
                      new Contracts.RecordingError({
                        reason: "refused",
                        ...(typeof reply.error.code === "string"
                          ? { code: reply.error.code.slice(0, 160) }
                          : {}),
                      }),
                    );
                    return;
                  }
                  if (reply.result === undefined) {
                    done(new Contracts.RecordingError({ reason: "invalid_response" }));
                    return;
                  }
                  done(undefined, reply.result);
                } catch {
                  done(new Contracts.RecordingError({ reason: "invalid_response" }));
                }
              });
            }),
          catch: (cause) =>
            isRecordingError(cause)
              ? cause
              : new Contracts.RecordingError({ reason: "unavailable" }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: 30_000,
            orElse: () => Effect.fail(new Contracts.RecordingError({ reason: "timeout" })),
          }),
        );
      }).pipe(
        Effect.mapError((cause) =>
          isRecordingError(cause) ? cause : new Contracts.RecordingError({ reason: "unavailable" }),
        ),
      );
    return RecordingTransport.of({ request });
  }),
);
