// @effect-diagnostics nodeBuiltinImport:off - Opaque expiring media grants and native binary chunks.
import * as NodeCrypto from "node:crypto";
import * as C from "@t3tools/contracts/deckhand/recordingsRpc";
import * as Context from "effect/Context";
import { AuthSessionId, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as RecordingTransport from "./RecordingTransport.ts";
const Chunk = Schema.Struct({
  size: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  offset: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  data: Schema.String.check(Schema.isMaxLength(349_528)),
  mimeType: Schema.Literals([
    "video/mp4",
    "video/quicktime",
    "image/jpeg",
    "image/png",
    "application/json",
    "text/markdown",
    "text/plain",
  ]),
  version: Schema.String.check(Schema.isMaxLength(160)),
});
export type MediaGrant = {
  readonly actorID: string;
  readonly input: C.RecordingIdentity;
  readonly expiresAt: number;
  readonly size: number;
  readonly mimeType: string;
  readonly version: string;
  readonly resource?: { readonly preparationID: string; readonly resourceID: string };
  readonly name?: string;
  readonly thumbnailID?: string;
};
export class Recordings extends Context.Service<
  Recordings,
  {
    readonly thumbnail: (
      actor: string,
      input: C.RecordingIdentity,
    ) => Effect.Effect<C.RecordingThumbnail, C.RecordingError>;
    readonly readEvidenceChunk: (
      actor: string,
      input: C.EvidenceChunkInput,
    ) => Effect.Effect<C.EvidenceChunk, C.RecordingError>;
    readonly prepareEvidence: (
      actor: string,
      input: C.EvidencePrepare,
    ) => Effect.Effect<C.EvidencePreparation, C.RecordingError>;
    readonly getEvidence: (
      actor: string,
      input: C.EvidenceIdentity,
    ) => Effect.Effect<C.EvidencePreparation, C.RecordingError>;
    readonly evidenceResource: (
      actor: string,
      input: C.EvidenceResourceInput,
    ) => Effect.Effect<C.RecordingMedia, C.RecordingError>;
    readonly overview: (
      actor: string,
      input: C.RecordingOverviewInput,
    ) => Effect.Effect<ReadonlyArray<C.RecordingContextOverview>, C.RecordingError>;
    readonly list: (
      actor: string,
      input: C.RecordingContext,
    ) => Effect.Effect<ReadonlyArray<C.Recording>, C.RecordingError>;
    readonly get: (
      actor: string,
      input: C.RecordingIdentity,
    ) => Effect.Effect<C.Recording, C.RecordingError>;
    readonly windows: (
      actor: string,
      input: C.RecordingContext,
    ) => Effect.Effect<ReadonlyArray<C.RecordingWindow>, C.RecordingError>;
    readonly start: (
      actor: string,
      input: C.RecordingStart,
    ) => Effect.Effect<C.Recording, C.RecordingError>;
    readonly control: (
      actor: string,
      input: C.RecordingControl,
    ) => Effect.Effect<C.Recording, C.RecordingError>;
    readonly logs: (
      actor: string,
      input: C.RecordingLogInput,
    ) => Effect.Effect<C.RecordingLogs, C.RecordingError>;
    readonly mark: (
      actor: string,
      input: C.RecordingMark,
    ) => Effect.Effect<C.Recording, C.RecordingError>;
    readonly media: (
      actor: string,
      input: C.RecordingIdentity,
    ) => Effect.Effect<C.RecordingMedia, C.RecordingError>;
    readonly grant: (token: string) => Effect.Effect<MediaGrant, C.RecordingError>;
    readonly chunk: (
      token: string,
      offset: number,
      length: number,
    ) => Effect.Effect<Uint8Array, C.RecordingError>;
  }
>()("t3/deckhand/Recordings") {}
const ThumbnailMetadata = Schema.Struct({
  ...Chunk.fields,
  thumbnailID: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  width: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(480),
  ),
  height: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(480),
  ),
});
const decodeSessionID = Schema.decodeUnknownEffect(AuthSessionId);
const decodeChunk = Schema.decodeUnknownEffect(Chunk);
const isError = Schema.is(C.RecordingError);
export const layer = Layer.effect(
  Recordings,
  Effect.gen(function* () {
    const transport = yield* RecordingTransport.RecordingTransport;
    const grants = new Map<string, MediaGrant>();
    const sessions = yield* AuthSessions.AuthSessionRepository;
    const reserveGrant = (nowMillis: number) => {
      for (const [key, value] of grants) if (value.expiresAt <= nowMillis) grants.delete(key);
      if (grants.size >= 128) {
        // Library stills should not evict an already playing video's grant.
        const oldestThumbnail = Array.from(grants).find(([, value]) => value.thumbnailID);
        const key = oldestThumbnail?.[0] ?? grants.keys().next().value;
        if (key) grants.delete(key);
      }
    };
    const decode =
      <A, I>(schema: Schema.Codec<A, I>) =>
      (value: unknown) =>
        Schema.decodeUnknownEffect(schema)(value).pipe(
          Effect.mapError(() => new C.RecordingError({ reason: "invalid_response" })),
        );
    const prepareEvidence: Recordings["Service"]["prepareEvidence"] = (actor, input) =>
      transport.request(actor, "integration.recording.evidence.prepare", input).pipe(
        Effect.flatMap(decode(C.EvidencePreparation)),
        Effect.flatMap((result) =>
          result.recordingID === input.recordingID
            ? Effect.succeed(result)
            : Effect.fail(new C.RecordingError({ reason: "wrong_evidence_context" })),
        ),
      );
    const getEvidence: Recordings["Service"]["getEvidence"] = (actor, input) =>
      transport.request(actor, "integration.recording.evidence.get", input).pipe(
        Effect.flatMap(decode(C.EvidencePreparation)),
        Effect.flatMap((result) =>
          result.recordingID === input.recordingID && result.preparationID === input.preparationID
            ? Effect.succeed(result)
            : Effect.fail(new C.RecordingError({ reason: "wrong_evidence_context" })),
        ),
      );
    const overview: Recordings["Service"]["overview"] = (actor, input) =>
      transport
        .request(actor, "integration.recording.overview", input)
        .pipe(Effect.flatMap(decode(Schema.Array(C.RecordingContextOverview))));
    const list: Recordings["Service"]["list"] = (actor, input) =>
      transport
        .request(actor, "integration.recording.list", input)
        .pipe(Effect.flatMap(decode(Schema.Array(C.Recording))));
    const get: Recordings["Service"]["get"] = (actor, input) =>
      transport
        .request(actor, "integration.recording.get", input)
        .pipe(Effect.flatMap(decode(C.Recording)));
    const windows: Recordings["Service"]["windows"] = (actor, input) =>
      transport
        .request(actor, "integration.recording.windows", input)
        .pipe(Effect.flatMap(decode(Schema.Array(C.RecordingWindow))));
    const start: Recordings["Service"]["start"] = (actor, input) =>
      transport
        .request(actor, "integration.recording.start", input)
        .pipe(Effect.flatMap(decode(C.Recording)));
    const control: Recordings["Service"]["control"] = (actor, { action, ...input }) =>
      transport
        .request(actor, `integration.recording.${action}`, input)
        .pipe(Effect.flatMap(decode(C.Recording)));
    const logs: Recordings["Service"]["logs"] = (actor, input) =>
      transport
        .request(actor, "integration.recording.logs", input)
        .pipe(Effect.flatMap(decode(C.RecordingLogs)));
    const mark: Recordings["Service"]["mark"] = (actor, input) =>
      transport
        .request(actor, "integration.recording.mark", input)
        .pipe(Effect.flatMap(decode(C.Recording)));
    const grant: Recordings["Service"]["grant"] = (token) =>
      Effect.gen(function* () {
        const value = grants.get(token);
        const nowMillis = yield* Clock.currentTimeMillis;
        if (!value || value.expiresAt <= nowMillis) {
          grants.delete(token);
          return yield* new C.RecordingError({ reason: "media_expired" });
        }
        const sessionId = yield* decodeSessionID(value.actorID).pipe(
          Effect.mapError(() => new C.RecordingError({ reason: "media_expired" })),
        );
        const session = yield* sessions
          .getById({ sessionId })
          .pipe(Effect.mapError(() => new C.RecordingError({ reason: "media_expired" })));
        const now = yield* DateTime.now;
        if (
          Option.isNone(session) ||
          session.value.revokedAt !== null ||
          session.value.expiresAt.epochMilliseconds <= now.epochMilliseconds ||
          !session.value.scopes.includes(AuthOrchestrationReadScope)
        ) {
          grants.delete(token);
          return yield* new C.RecordingError({ reason: "media_expired" });
        }
        return value;
      });
    const media: Recordings["Service"]["media"] = (actor, input) =>
      Effect.gen(function* () {
        const recording = yield* get(actor, input);
        if (!recording.playable)
          return yield* new C.RecordingError({ reason: "video_unavailable" });
        const info = yield* transport
          .request(actor, "integration.recording.chunk", { ...input, offset: 0, length: 0 })
          .pipe(Effect.flatMap(decodeChunk));
        const nowMillis = yield* Clock.currentTimeMillis;
        reserveGrant(nowMillis);
        const token = NodeCrypto.randomBytes(32).toString("hex");
        const expiresAt = nowMillis + 10 * 60 * 1000;
        grants.set(token, {
          actorID: actor,
          input,
          expiresAt,
          size: info.size,
          mimeType: info.mimeType,
          version: info.version,
        });
        return {
          path: `/api/deckhand/recordings/media/${token}`,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
          size: info.size,
          mimeType: info.mimeType,
        };
      }).pipe(
        Effect.mapError((cause) =>
          isError(cause) ? cause : new C.RecordingError({ reason: "invalid_response" }),
        ),
      );
    const thumbnail: Recordings["Service"]["thumbnail"] = (actor, input) =>
      Effect.gen(function* () {
        const info = yield* transport
          .request(actor, "integration.recording.thumbnail", input)
          .pipe(Effect.flatMap(decode(ThumbnailMetadata)));
        if (
          info.mimeType !== "image/jpeg" ||
          info.size < 1 ||
          info.size > 262144 ||
          info.offset !== 0 ||
          info.data !== ""
        )
          return yield* new C.RecordingError({ reason: "invalid_thumbnail" });
        const nowMillis = yield* Clock.currentTimeMillis;
        const existing = Array.from(grants).find(
          ([, value]) =>
            value.actorID === actor &&
            value.thumbnailID === info.thumbnailID &&
            value.version === info.version &&
            value.input.installationID === input.installationID &&
            value.input.workspaceID === input.workspaceID &&
            value.input.generation === input.generation &&
            value.input.recordingID === input.recordingID &&
            value.expiresAt > nowMillis + 60000,
        );
        if (!existing) reserveGrant(nowMillis);
        const token = existing?.[0] ?? NodeCrypto.randomBytes(32).toString("hex");
        const expiresAt = existing?.[1].expiresAt ?? nowMillis + 10 * 60 * 1000;
        if (!existing)
          grants.set(token, {
            actorID: actor,
            input,
            expiresAt,
            size: info.size,
            mimeType: info.mimeType,
            version: info.version,
            thumbnailID: info.thumbnailID,
          });
        yield* grant(token);
        return {
          path: `/api/deckhand/recordings/media/${token}`,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
          size: info.size,
          mimeType: info.mimeType,
          sha256: info.sha256,
          width: info.width,
          height: info.height,
        };
      }).pipe(
        Effect.mapError((cause) =>
          isError(cause) ? cause : new C.RecordingError({ reason: "invalid_response" }),
        ),
      );
    const readEvidenceChunk: Recordings["Service"]["readEvidenceChunk"] = (actor, input) =>
      Effect.gen(function* () {
        if (
          !Number.isSafeInteger(input.offset) ||
          input.offset < 0 ||
          !Number.isSafeInteger(input.length) ||
          input.length < 1 ||
          input.length > 65536
        )
          return yield* new C.RecordingError({ reason: "invalid_range" });
        const { offset, length, resourceID, ...preparationInput } = input;
        const preparation = yield* getEvidence(actor, preparationInput);
        const asset = preparation.assets.find(
          (value) => value.id === resourceID && value.state === "ready",
        );
        if (preparation.state !== "ready" || !asset || !asset.sha256 || offset > asset.size)
          return yield* new C.RecordingError({ reason: "asset_unavailable" });
        const chunk = yield* transport
          .request(actor, "integration.recording.evidence.chunk", input)
          .pipe(Effect.flatMap(decodeChunk));
        const bytes = Buffer.from(chunk.data, "base64");
        if (
          chunk.size !== asset.size ||
          chunk.offset !== offset ||
          chunk.mimeType !== asset.mimeType ||
          bytes.length !== Math.min(length, asset.size - offset) ||
          bytes.toString("base64") !== chunk.data
        )
          return yield* new C.RecordingError({ reason: "asset_changed" });
        return {
          offset,
          size: chunk.size,
          mimeType: chunk.mimeType,
          version: chunk.version,
          data: chunk.data,
          nextOffset: offset + bytes.length < chunk.size ? offset + bytes.length : null,
        };
      }).pipe(
        Effect.mapError((cause) =>
          isError(cause) ? cause : new C.RecordingError({ reason: "invalid_response" }),
        ),
      );
    const evidenceResource: Recordings["Service"]["evidenceResource"] = (actor, input) =>
      Effect.gen(function* () {
        const { resourceID, ...preparationInput } = input;
        const preparation = yield* getEvidence(actor, preparationInput);
        if (
          preparation.state !== "ready" ||
          preparation.recordingID !== input.recordingID ||
          preparation.preparationID !== input.preparationID
        )
          return yield* new C.RecordingError({ reason: "evidence_unavailable" });
        const asset = preparation.assets.find(
          (value) => value.id === resourceID && value.state === "ready",
        );
        if (!asset || !asset.sha256 || !/^[a-f0-9]{64}$/.test(asset.sha256))
          return yield* new C.RecordingError({ reason: "asset_unavailable" });
        const info = yield* transport
          .request(actor, "integration.recording.evidence.chunk", {
            ...input,
            offset: 0,
            length: 0,
          })
          .pipe(Effect.flatMap(decodeChunk));
        if (info.size !== asset.size || info.mimeType !== asset.mimeType)
          return yield* new C.RecordingError({ reason: "asset_changed" });
        const nowMillis = yield* Clock.currentTimeMillis;
        reserveGrant(nowMillis);
        const token = NodeCrypto.randomBytes(32).toString("hex");
        const expiresAt = nowMillis + 10 * 60 * 1000;
        const { preparationID, ...identity } = preparationInput;
        grants.set(token, {
          actorID: actor,
          input: identity,
          resource: { preparationID, resourceID },
          name: asset.name,
          expiresAt,
          size: info.size,
          mimeType: info.mimeType,
          version: info.version,
        });
        // Reuse the live upstream session check for all evidence grants.
        yield* grant(token);
        return {
          path: `/api/deckhand/recordings/media/${token}`,
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresAt)),
          size: info.size,
          mimeType: info.mimeType,
        };
      }).pipe(
        Effect.mapError((cause) =>
          isError(cause) ? cause : new C.RecordingError({ reason: "invalid_response" }),
        ),
      );
    const chunk: Recordings["Service"]["chunk"] = (token, offset, length) =>
      Effect.gen(function* () {
        const value = yield* grant(token);
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > value.size ||
          !Number.isSafeInteger(length) ||
          length < 1 ||
          length > 262_144
        )
          return yield* new C.RecordingError({ reason: "invalid_range" });
        const result = yield* transport
          .request(
            value.actorID,
            value.thumbnailID
              ? "integration.recording.thumbnail.chunk"
              : value.resource
                ? "integration.recording.evidence.chunk"
                : "integration.recording.chunk",
            {
              ...value.input,
              ...value.resource,
              ...(value.thumbnailID ? { thumbnailID: value.thumbnailID } : {}),
              offset,
              length,
            },
          )
          .pipe(Effect.flatMap(decodeChunk));
        const bytes = Buffer.from(result.data, "base64");
        if (
          result.size !== value.size ||
          result.offset !== offset ||
          result.mimeType !== value.mimeType ||
          result.version !== value.version ||
          bytes.length !== Math.min(length, value.size - offset) ||
          bytes.toString("base64") !== result.data
        )
          return yield* new C.RecordingError({ reason: "video_changed" });
        return bytes;
      }).pipe(
        Effect.mapError((cause) =>
          isError(cause) ? cause : new C.RecordingError({ reason: "invalid_response" }),
        ),
      );
    return Recordings.of({
      thumbnail,
      readEvidenceChunk,
      prepareEvidence,
      getEvidence,
      evidenceResource,
      overview,
      list,
      get,
      windows,
      start,
      control,
      logs,
      mark,
      media,
      grant,
      chunk,
    });
  }),
);
