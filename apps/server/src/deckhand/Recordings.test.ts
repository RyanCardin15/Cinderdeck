import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as C from "@t3tools/contracts/deckhand/recordingsRpc";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as RecordingTransport from "./RecordingTransport.ts";
import * as Recordings from "./Recordings.ts";
const context: C.RecordingIdentity = {
  installationID: "install",
  workspaceID: "lane",
  generation: 2,
  recordingID: "recording",
};
const recording: C.Recording = {
  id: "recording",
  title: "Retry verification",
  state: "ready",
  createdAt: "2026-10-04T00:00:00Z",
  duration: 4,
  actor: "Codex",
  capture: "Browser window",
  primaryWorkspaceID: "lane",
  capturedWorkspaceIDs: ["lane", "api"],
  capturedWorkspaceNames: ["Lane", "API"],
  lineCount: 3,
  errorCount: 1,
  warningCount: 0,
  playable: true,
  paused: false,
  controlAllowed: false,
  detail: null,
  checkOutcome: "unverified",
  markers: [],
  repositories: [
    { workspaceID: "lane", repositoryID: "web", branch: "fix/retry", head: "abc", changedFiles: 2 },
  ],
};
const decodeSession = Schema.decodeUnknownSync(AuthSessions.AuthSessionRecord);
const actor = "auth-session";
const authRecord = () =>
  decodeSession({
    sessionId: actor,
    subject: "user",
    scopes: [AuthOrchestrationReadScope],
    method: "bearer-access-token",
    client: {
      label: null,
      ipAddress: null,
      userAgent: null,
      deviceType: "unknown",
      os: null,
      browser: null,
    },
    issuedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2099-01-01T00:00:00Z",
    revokedAt: null,
    lastConnectedAt: null,
  });
const testLayer = (
  request: RecordingTransport.RecordingTransport["Service"]["request"],
  session: () => Option.Option<AuthSessions.AuthSessionRecord> = () => Option.some(authRecord()),
) =>
  Recordings.layer.pipe(
    Layer.provide(Layer.mock(RecordingTransport.RecordingTransport)({ request })),
    Layer.provide(
      Layer.mock(AuthSessions.AuthSessionRepository)({ getById: () => Effect.sync(session) }),
    ),
  );
const evidence: C.EvidencePreparation = {
  preparationID: "preparation",
  recordingID: "recording",
  state: "ready",
  detail: null,
  assets: [
    {
      id: "asset",
      name: "recording.log",
      kind: "logs",
      mimeType: "text/plain",
      size: 4,
      sha256: "a".repeat(64),
      state: "ready",
      detail: null,
    },
    {
      id: "missing-video",
      name: "recording.mp4",
      kind: "video",
      mimeType: "video/mp4",
      size: 0,
      sha256: null,
      state: "missing",
      detail: "Missing source",
    },
  ],
};
describe("recording evidence and media authority", () => {
  it.effect(
    "serves bounded immutable thumbnails through the same revocable opaque media transport",
    () => {
      let revoked = false;
      const calls: Array<{ actor: string; method: string; input: Record<string, unknown> }> = [];
      return Effect.gen(function* () {
        const service = yield* Recordings.Recordings;
        const image = yield* service.thumbnail(actor, context);
        assert.equal(image.mimeType, "image/jpeg");
        assert.equal(image.width, 480);
        assert.equal(image.sha256, "b".repeat(64));
        const token = image.path.split("/").at(-1)!;
        assert.deepEqual(Array.from(yield* service.chunk(token, 0, 4)), [1, 2, 3, 4]);
        assert.deepEqual(calls.at(-1), {
          actor,
          method: "integration.recording.thumbnail.chunk",
          input: { ...context, thumbnailID: "c".repeat(64), offset: 0, length: 4 },
        });
        const count = calls.length;
        revoked = true;
        assert.equal((yield* service.chunk(token, 0, 4).pipe(Effect.flip)).reason, "media_expired");
        assert.equal(calls.length, count);
      }).pipe(
        Effect.provide(
          testLayer(
            (actor, method, input) =>
              Effect.sync(() => {
                calls.push({ actor, method, input });
                return {
                  size: 4,
                  offset: input.offset ?? 0,
                  data: method.endsWith(".chunk")
                    ? Buffer.from([1, 2, 3, 4]).toString("base64")
                    : "",
                  mimeType: "image/jpeg",
                  version: "thumbnail1",
                  thumbnailID: "c".repeat(64),
                  sha256: "b".repeat(64),
                  width: 480,
                  height: 270,
                };
              }),
            () => (revoked ? Option.none() : Option.some(authRecord())),
          ),
        ),
      );
    },
  );
  it.effect(
    "rejects oversized or invalid native thumbnail metadata before issuing a media URL",
    () => {
      return Effect.gen(function* () {
        const service = yield* Recordings.Recordings;
        assert.equal(
          (yield* service.thumbnail(actor, context).pipe(Effect.flip)).reason,
          "invalid_thumbnail",
        );
      }).pipe(
        Effect.provide(
          testLayer(() =>
            Effect.succeed({
              size: 262145,
              offset: 0,
              data: "",
              mimeType: "image/jpeg",
              version: "thumbnail1",
              thumbnailID: "c".repeat(64),
              sha256: "b".repeat(64),
              width: 480,
              height: 270,
            }),
          ),
        ),
      );
    },
  );

  it.effect(
    "keeps error observations, checks and captured repository dirt separate, and controls the exact selected recording",
    () => {
      const calls: Array<{ actor: string; method: string; input: unknown }> = [];
      return Effect.gen(function* () {
        const service = yield* Recordings.Recordings;
        const result = yield* service.get(actor, context);
        assert.equal(result.checkOutcome, "unverified");
        assert.equal(result.errorCount, 1);
        assert.equal(result.repositories[0]?.changedFiles, 2);
        yield* service.control(actor, { ...context, action: "stop" });
        assert.deepEqual(calls[1], { actor, method: "integration.recording.stop", input: context });
      }).pipe(
        Effect.provide(
          testLayer((actor, method, input) =>
            Effect.sync(() => {
              calls.push({ actor, method, input });
              return recording;
            }),
          ),
        ),
      );
    },
  );
  it.effect(
    "streams bounded media and invalidates an existing URL as soon as the owner session is revoked",
    () => {
      let revoked = false;
      let chunks = 0;
      return Effect.gen(function* () {
        const service = yield* Recordings.Recordings;
        const media = yield* service.media(actor, context);
        const token = media.path.split("/").at(-1)!;
        assert.equal(media.size, 4);
        assert.deepEqual(Array.from(yield* service.chunk(token, 1, 2)), [2, 3]);
        assert.equal(chunks, 1);
        revoked = true;
        assert.equal((yield* service.chunk(token, 0, 4).pipe(Effect.flip)).reason, "media_expired");
        assert.equal(chunks, 1);
        assert.equal((yield* service.grant(token).pipe(Effect.flip)).reason, "media_expired");
      }).pipe(
        Effect.provide(
          testLayer(
            (_actor, method, input) =>
              Effect.sync(() => {
                if (method === "integration.recording.get") return recording;
                const offset = Number(input.offset);
                const length = Number(input.length);
                if (length) chunks++;
                return {
                  size: 4,
                  offset,
                  data: Buffer.from([1, 2, 3, 4].slice(offset, offset + length)).toString("base64"),
                  mimeType: "video/mp4",
                  version: "source1",
                };
              }),
            () => (revoked ? Option.none() : Option.some(authRecord())),
          ),
        ),
      );
    },
  );
  it.effect(
    "delivers only the selected prepared asset and revokes its grant with the owning auth session",
    () => {
      let revoked = false;
      const calls: Array<{ actor: string; method: string; input: Record<string, unknown> }> = [];
      return Effect.gen(function* () {
        const service = yield* Recordings.Recordings;
        const identity = { ...context, preparationID: "preparation", resourceID: "asset" };
        const prepared = yield* service.prepareEvidence(actor, {
          ...context,
          operationKey: "prepare-key",
        });
        assert.equal(prepared.preparationID, "preparation");
        const resource = yield* service.evidenceResource(actor, identity);
        const token = resource.path.split("/").at(-1)!;
        assert.equal(resource.mimeType, "text/plain");
        assert.deepEqual(Array.from(yield* service.chunk(token, 1, 2)), [2, 3]);
        assert.deepEqual(calls.at(-1), {
          actor,
          method: "integration.recording.evidence.chunk",
          input: { ...identity, offset: 1, length: 2 },
        });
        const count = calls.length;
        revoked = true;
        assert.equal((yield* service.chunk(token, 0, 1).pipe(Effect.flip)).reason, "media_expired");
        assert.equal(calls.length, count);
      }).pipe(
        Effect.provide(
          testLayer(
            (actor, method, input) =>
              Effect.sync(() => {
                calls.push({ actor, method, input });
                if (method.endsWith(".get") || method.endsWith(".prepare")) return evidence;
                const offset = input.offset as number;
                const length = input.length as number;
                return {
                  size: 4,
                  offset,
                  data: Buffer.from([1, 2, 3, 4].slice(offset, offset + length)).toString("base64"),
                  mimeType: "text/plain",
                  version: "asset-version",
                };
              }),
            () => (revoked ? Option.none() : Option.some(authRecord())),
          ),
        ),
      );
    },
  );
  it.effect(
    "refuses missing assets and mismatched preparation identities before requesting source bytes",
    () => {
      let requests = 0;
      return Effect.gen(function* () {
        const service = yield* Recordings.Recordings;
        assert.equal(
          (yield* service
            .evidenceResource(actor, {
              ...context,
              preparationID: "preparation",
              resourceID: "missing-video",
            })
            .pipe(Effect.flip)).reason,
          "asset_unavailable",
        );
        assert.equal(
          (yield* service
            .getEvidence(actor, { ...context, preparationID: "another-preparation" })
            .pipe(Effect.flip)).reason,
          "wrong_evidence_context",
        );
        assert.equal(
          (yield* service
            .prepareEvidence(actor, {
              ...context,
              recordingID: "another-recording",
              operationKey: "key",
            })
            .pipe(Effect.flip)).reason,
          "wrong_evidence_context",
        );
        assert.equal(requests, 3);
      }).pipe(
        Effect.provide(
          testLayer((_actor, _method, _input) =>
            Effect.sync(() => {
              requests++;
              return evidence;
            }),
          ),
        ),
      );
    },
  );
  it.effect(
    "reads bounded MCP evidence bytes with exact native ownership and no HTTP auth grant",
    () => {
      const calls: Array<{ actor: string; method: string; input: Record<string, unknown> }> = [];
      let authLookups = 0;
      return Effect.gen(function* () {
        const service = yield* Recordings.Recordings;
        const input: C.EvidenceChunkInput = {
          ...context,
          preparationID: "preparation",
          resourceID: "asset",
          offset: 1,
          length: 2,
        };
        assert.deepEqual(yield* service.readEvidenceChunk("mcp:provider-session", input), {
          offset: 1,
          size: 4,
          mimeType: "text/plain",
          version: "asset-version",
          data: "AgM=",
          nextOffset: 3,
        });
        assert.deepEqual(calls.at(-1), {
          actor: "mcp:provider-session",
          method: "integration.recording.evidence.chunk",
          input,
        });
        const count = calls.length;
        assert.equal(
          (yield* service
            .readEvidenceChunk("mcp:provider-session", { ...input, length: 65537 })
            .pipe(Effect.flip)).reason,
          "invalid_range",
        );
        assert.equal(calls.length, count);
        assert.equal(authLookups, 0);
      }).pipe(
        Effect.provide(
          testLayer(
            (actor, method, input) =>
              Effect.sync(() => {
                calls.push({ actor, method, input });
                if (method.endsWith(".get")) return evidence;
                const offset = input.offset as number;
                const length = input.length as number;
                return {
                  size: 4,
                  offset,
                  data: Buffer.from([1, 2, 3, 4].slice(offset, offset + length)).toString("base64"),
                  mimeType: "text/plain",
                  version: "asset-version",
                };
              }),
            () => {
              authLookups++;
              return Option.none();
            },
          ),
        ),
      );
    },
  );
  it.effect("does not read MCP bytes when native preparation ownership is refused", () =>
    Effect.gen(function* () {
      const service = yield* Recordings.Recordings;
      const error = yield* service
        .readEvidenceChunk("mcp:another-session", {
          ...context,
          preparationID: "preparation",
          resourceID: "asset",
          offset: 0,
          length: 4,
        })
        .pipe(Effect.flip);
      assert.equal(error.code, "not_owner");
    }).pipe(
      Effect.provide(
        testLayer((_actor, method) => {
          assert.equal(method, "integration.recording.evidence.get");
          return Effect.fail(new C.RecordingError({ reason: "refused", code: "not_owner" }));
        }),
      ),
    ),
  );
  it.effect("refuses changed video size rather than mixing byte ranges from different files", () =>
    Effect.gen(function* () {
      const service = yield* Recordings.Recordings;
      const media = yield* service.media(actor, context);
      const token = media.path.split("/").at(-1)!;
      assert.equal((yield* service.chunk(token, 0, 4).pipe(Effect.flip)).reason, "video_changed");
      assert.equal(
        (yield* service.chunk(token, 0, 262_145).pipe(Effect.flip)).reason,
        "invalid_range",
      );
    }).pipe(
      Effect.provide(
        testLayer((_actor, method, input) =>
          Effect.succeed(
            method.endsWith(".get")
              ? recording
              : {
                  size: input.length === 0 ? 4 : 5,
                  offset: 0,
                  data: input.length === 0 ? "" : "AQIDBA==",
                  mimeType: "video/mp4",
                  version: "source1",
                },
          ),
        ),
      ),
    ),
  );
});
