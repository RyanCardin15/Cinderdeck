import * as C from "@cinderdeck/contracts/deckhand/ownedPreviewRpc";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as ServerConfig from "../config.ts";
import * as Capture from "./OwnedPreviewCapture.ts";
import { privateCredentialMatches } from "./OwnedPreviewAttestations.ts";
const PRIVATE_OWNED_PREVIEW_ROUTE = "/api/deckhand/owned-preview";
const Request = Schema.Union([
  Schema.Struct({ action: Schema.Literal("begin"), input: C.OwnedPreviewBegin }),
  Schema.Struct({ action: Schema.Literal("event"), input: C.OwnedPreviewEvent }),
  Schema.Struct({ action: Schema.Literal("chunk"), input: C.OwnedPreviewChunk }),
  Schema.Struct({ action: Schema.Literal("finish"), input: C.OwnedPreviewFinish }),
  Schema.Struct({ action: Schema.Literal("get"), input: C.OwnedPreviewPrivateIdentity }),
]);
const decode = Schema.decodeUnknownEffect(Request);
export const routesLayer = HttpRouter.add(
  "POST",
  PRIVATE_OWNED_PREVIEW_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    // This credential is only delivered on the child's private bootstrap FD. It is
    // independent from the renderer's administrative bootstrap and pairing grants.
    if (
      config.mode !== "desktop" ||
      !privateCredentialMatches(
        config.desktopCaptureToken,
        request.headers["x-deckhand-capture-key"],
      )
    )
      return HttpServerResponse.empty({ status: 404 });
    const size = Number(request.headers["content-length"]);
    if (!Number.isSafeInteger(size) || size <= 0 || size > 400000)
      return HttpServerResponse.empty({ status: 413 });
    const raw = yield* request.json;
    const body = yield* decode(raw);
    const service = yield* Capture.OwnedPreviewCapture;
    const result = yield* body.action === "begin"
      ? service.begin(body.input)
      : body.action === "event"
        ? service.event(body.input)
        : body.action === "chunk"
          ? service.chunk(body.input)
          : body.action === "finish"
            ? service.finish(body.input)
            : service.recover(body.input);
    return yield* HttpServerResponse.json(result, { headers: { "cache-control": "no-store" } });
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.text("Owned preview capture refused or unavailable", {
          status: 409,
          headers: { "cache-control": "no-store" },
        }),
      ),
    ),
  ),
);
