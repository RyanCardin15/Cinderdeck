import {
  type DpopVerificationFailureCode as DpopVerificationFailureCodeType,
  type DpopVerificationResult,
  verifyDpopProof,
} from "@cinderdeck/shared/dpop";
import type { DpopFailureReason } from "@cinderdeck/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import {
  ServerAuthDpopReplayKeyCalculationError,
  ServerAuthDpopReplayStateRecordError,
  ServerAuthInvalidCredentialError,
  type ServerAuthInternalError,
} from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

/** Secret store name prefix of DPoP replay markers. The server prunes expired ones. */
export const DPOP_REPLAY_MARKER_PREFIX = "dpop-proof-";

export const mapDpopFailureReason = (code: DpopVerificationFailureCodeType): DpopFailureReason => {
  switch (code) {
    case "time_window":
      return "time_window";
    case "key_mismatch":
      return "key_mismatch";
    case "method_mismatch":
    case "url_mismatch":
      return "request_mismatch";
    case "access_token_hash_mismatch":
      return "token_mismatch";
    case "missing_proof":
    case "malformed_proof":
    case "invalid_signature":
    case "invalid_proof":
      return "invalid_proof";
  }
};

export const mapDpopReplayStoreError = (
  error: ServerSecretStore.SecretStoreError,
): ServerAuthInvalidCredentialError | ServerAuthInternalError =>
  ServerSecretStore.isSecretAlreadyExistsError(error)
    ? new ServerAuthInvalidCredentialError({
        diagnostic: "DPoP proof replayed.",
        dpopFailureReason: "replay",
        cause: error,
      })
    : new ServerAuthDpopReplayStateRecordError({
        cause: error,
      });

export type ValidatedDpopProof = Extract<DpopVerificationResult, { readonly ok: true }>;

export const validateRequestDpopProof = (input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly expectedThumbprint?: string;
  readonly expectedAccessToken?: string;
}) =>
  Effect.gen(function* () {
    const proof = input.request.headers.dpop;
    const url = HttpServerRequest.toURL(input.request);
    if (Option.isNone(url)) {
      return yield* new ServerAuthInvalidCredentialError({
        diagnostic: "Invalid DPoP request URL.",
      });
    }
    const now = yield* DateTime.now;
    const result = verifyDpopProof({
      proof,
      method: input.request.method,
      url: url.value.href,
      nowEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
      ...(input.expectedThumbprint ? { expectedThumbprint: input.expectedThumbprint } : {}),
      ...(input.expectedAccessToken ? { expectedAccessToken: input.expectedAccessToken } : {}),
    });
    if (!result.ok) {
      yield* Effect.annotateCurrentSpan({
        "environment.dpop.failure_code": result.code,
      });
      return yield* new ServerAuthInvalidCredentialError({
        diagnostic: result.reason,
        dpopFailureReason: mapDpopFailureReason(result.code),
      });
    }
    return result;
  });

const replayMarkerName = (proof: ValidatedDpopProof) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.digest("SHA-256", new TextEncoder().encode(`${proof.thumbprint}:${proof.jti}`)),
    ),
    Effect.map(Encoding.encodeBase64Url),
    Effect.map((key) => `${DPOP_REPLAY_MARKER_PREFIX}${key}`),
    Effect.mapError((cause) => new ServerAuthDpopReplayKeyCalculationError({ cause })),
  );

/** Checking a replay before consuming a one-time bootstrap is read-only. */
export const checkDpopProofReplay = (proof: ValidatedDpopProof) =>
  Effect.gen(function* () {
    const store = yield* ServerSecretStore.ServerSecretStore;
    const marker = yield* store
      .get(yield* replayMarkerName(proof))
      .pipe(Effect.mapError((cause) => new ServerAuthDpopReplayStateRecordError({ cause })));
    if (Option.isSome(marker))
      return yield* new ServerAuthInvalidCredentialError({
        diagnostic: "DPoP proof replayed.",
        dpopFailureReason: "replay",
      });
  });

export const recordDpopProof = (result: ValidatedDpopProof) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const markerName = yield* replayMarkerName(result);
    yield* secretStore
      .create(
        markerName,
        new TextEncoder().encode(
          [
            `thumbprint=${result.thumbprint}`,
            `jti=${result.jti}`,
            `iat=${result.iat}`,
            `consumedAt=${DateTime.formatIso(now)}`,
          ].join("\n"),
        ),
      )
      .pipe(
        Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
          Effect.gen(function* () {
            const mapped = mapDpopReplayStoreError(error);
            if (mapped._tag === "ServerAuthInvalidCredentialError") {
              yield* Effect.annotateCurrentSpan({
                "environment.dpop.failure_code": mapped.dpopFailureReason,
              });
            }
            return yield* mapped;
          }),
        ),
      );
  });

export const verifyRequestDpopProof = (input: Parameters<typeof validateRequestDpopProof>[0]) =>
  validateRequestDpopProof(input).pipe(
    Effect.tap(recordDpopProof),
    Effect.map((proof) => proof.thumbprint),
  );
