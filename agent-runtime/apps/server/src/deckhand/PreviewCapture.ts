import * as C from "@cinderdeck/contracts/deckhand/recordingsRpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Relationships from "./Relationships.ts";
import * as RecordingTransport from "./RecordingTransport.ts";
const decodeReceipt = Schema.decodeUnknownEffect(C.PreviewImportReceipt);
export class PreviewCapture extends Context.Service<
  PreviewCapture,
  {
    readonly begin: (
      actor: string,
      input: C.PreviewImportBegin,
    ) => Effect.Effect<C.PreviewImportReceipt, C.RecordingError>;
    readonly get: (
      actor: string,
      input: C.PreviewImportLookup,
    ) => Effect.Effect<C.PreviewImportReceipt, C.RecordingError>;
    readonly event: (
      actor: string,
      input: C.PreviewImportEvent,
    ) => Effect.Effect<C.PreviewImportReceipt, C.RecordingError>;
    readonly upload: (
      actor: string,
      input: C.PreviewImportChunk,
    ) => Effect.Effect<C.PreviewImportReceipt, C.RecordingError>;
    readonly finish: (
      actor: string,
      input: C.PreviewImportControl,
    ) => Effect.Effect<C.PreviewImportReceipt, C.RecordingError>;
  }
>()("@cinderdeck/server/deckhand/PreviewCapture") {}
const isError = Schema.is(C.RecordingError);
export const layer = Layer.effect(
  PreviewCapture,
  Effect.gen(function* () {
    const transport = yield* RecordingTransport.RecordingTransport;
    const relationships = yield* Relationships.Relationships;
    const call = (
      actor: string,
      method: string,
      input: C.RecordingContext & Record<string, unknown>,
    ) =>
      transport.request(actor, `integration.recording.import.${method}`, input).pipe(
        Effect.flatMap(decodeReceipt),
        Effect.mapError((cause) =>
          isError(cause) ? cause : new C.RecordingError({ reason: "invalid_response" }),
        ),
      );
    const begin: PreviewCapture["Service"]["begin"] = (actor, input) =>
      Effect.gen(function* () {
        if (!input.sessionID)
          return yield* new C.RecordingError({ reason: "managed_session_required" });
        const session = yield* relationships.session(input.sessionID);
        const checkout = yield* relationships.checkout(session.checkoutId);
        const workspace = yield* relationships.workspace(checkout.workspaceId);
        const feature = yield* relationships.feature(session.featureId);
        if (
          checkout.backend !== "cinderdeck" ||
          checkout.state !== "ready" ||
          workspace.state !== "active" ||
          feature.status !== "active" ||
          feature.workspaceId !== workspace.id ||
          checkout.workspaceGeneration !== workspace.generation ||
          checkout.environmentId !== workspace.environmentId ||
          workspace.environmentId !== input.installationID ||
          checkout.nativeGeneration !== input.generation ||
          (checkout.laneId ?? workspace.ownerId) !== input.workspaceID
        )
          return yield* new C.RecordingError({ reason: "stale_context" });
        return yield* call(actor, "begin", {
          ...input,
          featureID: session.featureId,
          checkoutID: session.checkoutId,
        });
      }).pipe(
        Effect.mapError((cause) =>
          isError(cause) ? cause : new C.RecordingError({ reason: "context_unavailable" }),
        ),
      );
    const get: PreviewCapture["Service"]["get"] = (actor, input) => call(actor, "get", input);
    const event: PreviewCapture["Service"]["event"] = (actor, input) => call(actor, "event", input);
    const upload: PreviewCapture["Service"]["upload"] = (actor, input) =>
      call(actor, "chunk", input);
    const finish: PreviewCapture["Service"]["finish"] = (actor, input) =>
      call(actor, "finish", input);
    return PreviewCapture.of({ begin, get, event, upload, finish });
  }),
);
