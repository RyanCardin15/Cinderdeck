import * as C from "@t3tools/contracts/deckhand/builds";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as RecordingTransport from "./RecordingTransport.ts";
export class Builds extends Context.Service<
  Builds,
  {
    readonly describe: (
      actor: string,
      input: C.BuildDescribeInput,
    ) => Effect.Effect<C.BuildDescriptor, C.BuildError>;
    readonly prepare: (
      actor: string,
      input: C.BuildPrepareInput,
    ) => Effect.Effect<C.BuildReceipt, C.BuildError>;
    readonly get: (
      actor: string,
      input: C.BuildGetInput,
    ) => Effect.Effect<C.BuildReceipt, C.BuildError>;
    readonly launch: (
      actor: string,
      input: C.BuildActionInput,
    ) => Effect.Effect<C.BuildReceipt, C.BuildError>;
    readonly runChecks: (
      actor: string,
      input: C.BuildActionInput,
    ) => Effect.Effect<C.BuildReceipt, C.BuildError>;
    readonly observe: (
      actor: string,
      input: C.BuildObserveInput,
    ) => Effect.Effect<C.BuildObservation, C.BuildError>;
    readonly finish: (
      actor: string,
      input: C.BuildFinishInput,
    ) => Effect.Effect<C.BuildReceipt, C.BuildError>;
  }
>()("t3/deckhand/Builds") {}
export const layer = Layer.effect(
  Builds,
  Effect.gen(function* () {
    const transport = yield* RecordingTransport.RecordingTransport;
    const request = <A>(
      actor: string,
      method: string,
      input: { readonly installationID: string } & object,
      schema: Schema.Decoder<A>,
    ) =>
      transport.request(actor, method, input).pipe(
        Effect.mapError(
          (e) => new C.BuildError({ reason: e.reason, ...(e.code ? { code: e.code } : {}) }),
        ),
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(schema)(value).pipe(
            Effect.mapError(() => new C.BuildError({ reason: "invalid_response" })),
          ),
        ),
      );
    return Builds.of({
      describe: (a, i) => request(a, "integration.build.describe", i, C.BuildDescriptor),
      prepare: (a, i) => request(a, "integration.build.prepare", i, C.BuildReceipt),
      get: (a, i) => request(a, "integration.build.get", i, C.BuildReceipt),
      launch: (a, i) => request(a, "integration.build.launch", i, C.BuildReceipt),
      runChecks: (a, i) => request(a, "integration.build.runChecks", i, C.BuildReceipt),
      observe: (a, i) => request(a, "integration.build.observe", i, C.BuildObservation),
      finish: (a, i) => request(a, "integration.build.finish", i, C.BuildReceipt),
    });
  }),
);
