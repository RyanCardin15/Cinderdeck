import * as C from "@t3tools/contracts/deckhand/runsRpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as RecordingTransport from "./RecordingTransport.ts";
export class Runs extends Context.Service<
  Runs,
  {
    readonly list: (
      actor: string,
      input: C.RunContext,
    ) => Effect.Effect<C.RunsOverview, C.RunsError>;
    readonly get: (actor: string, input: C.RunGetInput) => Effect.Effect<C.RunDetail, C.RunsError>;
    readonly failures: (
      actor: string,
      input: C.RunFailuresInput,
    ) => Effect.Effect<C.RunFailures, C.RunsError>;
    readonly logs: (actor: string, input: C.RunLogInput) => Effect.Effect<C.RunLogs, C.RunsError>;
    readonly definition: (
      actor: string,
      input: C.RunContext,
    ) => Effect.Effect<C.RunDefinition, C.RunsError>;
    readonly validate: (
      actor: string,
      input: C.ValidateDefinition,
    ) => Effect.Effect<C.DefinitionValidation, C.RunsError>;
  }
>()("t3/deckhand/Runs") {}
export const layer = Layer.effect(
  Runs,
  Effect.gen(function* () {
    const transport = yield* RecordingTransport.RecordingTransport;
    const request = <A>(
      actor: string,
      method: string,
      input: C.RunContext & object,
      schema: Schema.Decoder<A>,
    ) =>
      transport.request(actor, method, input).pipe(
        Effect.mapError(
          (error) =>
            new C.RunsError({ reason: error.reason, ...(error.code ? { code: error.code } : {}) }),
        ),
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(schema)(value).pipe(
            Effect.mapError(() => new C.RunsError({ reason: "invalid_response" })),
          ),
        ),
      );
    return Runs.of({
      list: (actor, input) => request(actor, "integration.runs.list", input, C.RunsOverview),
      get: (actor, input) => request(actor, "integration.runs.get", input, C.RunDetail),
      failures: (actor, input) => request(actor, "integration.runs.failures", input, C.RunFailures),
      logs: (actor, input) => request(actor, "integration.runs.logs", input, C.RunLogs),
      definition: (actor, input) =>
        request(actor, "integration.runs.definition", input, C.RunDefinition),
      validate: (actor, input) =>
        request(actor, "integration.runs.definition.validate", input, C.DefinitionValidation),
    });
  }),
);
