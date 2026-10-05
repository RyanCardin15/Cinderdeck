import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Recordings from "./Recordings.ts";

export const layer = HttpRouter.add(
  "GET",
  "/api/deckhand/recordings/media/:token",
  Effect.gen(function* () {
    const { params } = yield* HttpRouter.RouteContext;
    const service = yield* Recordings.Recordings;
    const grant = yield* service.grant(params.token ?? "");
    const request = yield* HttpServerRequest.HttpServerRequest;
    let start = 0;
    let end = grant.size - 1;
    let partial = false;
    if (
      request.headers.range &&
      request.method !== "HEAD" &&
      request.headers["if-range"] === undefined
    ) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (!match || (!match[1] && !match[2]))
        return HttpServerResponse.empty({
          status: 416,
          headers: { "Content-Range": `bytes */${grant.size}` },
        });
      start = match[1] ? Number(match[1]) : Math.max(0, grant.size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), grant.size - 1) : grant.size - 1;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= grant.size
      )
        return HttpServerResponse.empty({
          status: 416,
          headers: { "Content-Range": `bytes */${grant.size}` },
        });
      partial = true;
    }
    const headers = {
      "Content-Type": grant.mimeType,
      ...(grant.name
        ? {
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(grant.name.replaceAll("/", "-"))}`,
          }
        : {}),
      "Cache-Control": "private, no-store",
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Length": String(Math.max(0, end - start + 1)),
      ...(partial ? { "Content-Range": `bytes ${start}-${end}/${grant.size}` } : {}),
    };
    if (request.method === "HEAD" || grant.size === 0)
      return HttpServerResponse.empty({ status: partial ? 206 : 200, headers });
    const body = Stream.unfold(
      start,
      Effect.fnUntraced(function* (offset: number) {
        if (offset > end) return;
        const bytes = yield* service.chunk(
          params.token ?? "",
          offset,
          Math.min(262_144, end - offset + 1),
        );
        return [bytes, offset + bytes.length] as const;
      }),
    );
    return HttpServerResponse.stream(body, { status: partial ? 206 : 200, headers });
  }).pipe(
    Effect.catchTags({
      RecordingError: () =>
        Effect.succeed(
          HttpServerResponse.empty({
            status: 404,
            headers: { "Cache-Control": "private, no-store" },
          }),
        ),
    }),
  ),
);
