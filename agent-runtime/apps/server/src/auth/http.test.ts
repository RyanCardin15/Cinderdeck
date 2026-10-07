import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@cinderdeck/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./http.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

let observedSecretsDir = "";
const configLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    observedSecretsDir = config.secretsDir;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(configLayer),
);
const routesLayer = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(authHttpApiLayer),
  Layer.provide(environmentAuthenticatedAuthLayer),
  Layer.provideMerge(environmentAuthLayer),
  Layer.provide(configLayer),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeJson(body),
  });

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
            HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.tryPromise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "rejects unauthenticated signed proofs without persisting replay state and still rejects authenticated replays",
  () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const clock = yield* Clock.Clock;
      const now = yield* Clock.currentTimeMillis;
      const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
        Context.add(Clock.Clock, clock),
      );
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(routesLayer, { disableLogger: true })),
        (environment) =>
          Effect.gen(function* () {
            const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
              namedCurve: "P-256",
            });
            const jwk = publicKey.export({ format: "jwk" });
            const sign = (
              jti: string,
              method = "POST",
              url = "http://127.0.0.1/oauth/token",
              accessToken?: string,
            ) => {
              const header = Buffer.from(
                JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk }),
              ).toString("base64url");
              const body = Buffer.from(
                JSON.stringify({
                  htm: method,
                  htu: url,
                  jti,
                  iat: Math.floor(now / 1000),
                  ...(accessToken
                    ? {
                        ath: NodeCrypto.createHash("sha256")
                          .update(accessToken)
                          .digest("base64url"),
                      }
                    : {}),
                }),
              ).toString("base64url");
              const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${body}`), {
                key: privateKey,
                dsaEncoding: "ieee-p1363",
              }).toString("base64url");
              return `${header}.${body}.${signature}`;
            };
            const exchange = (credential: string, proof: string, scope?: string) =>
              Effect.promise(() =>
                environment.handler(
                  new Request("http://127.0.0.1/oauth/token", {
                    method: "POST",
                    headers: {
                      host: "127.0.0.1",
                      "content-type": "application/x-www-form-urlencoded",
                      dpop: proof,
                    },
                    body: new URLSearchParams({
                      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
                      subject_token: credential,
                      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
                      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
                      ...(scope ? { scope } : {}),
                    }),
                  }),
                  requestContext,
                ),
              );
            const markers = () =>
              fileSystem
                .readDirectory(observedSecretsDir)
                .pipe(
                  Effect.map((names) => names.filter((name) => name.startsWith("dpop-proof-"))),
                );
            for (let i = 0; i < 8; i += 1)
              expect((yield* exchange("invalid-bootstrap", sign(`invalid-${i}`))).status).toBe(401);
            expect(yield* markers()).toHaveLength(0);
            const browser = yield* Effect.promise(() =>
              environment.handler(
                postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
                requestContext,
              ),
            );
            const cookie =
              browser.headers
                .getSetCookie()
                .find((value) => value.startsWith("t3_dev_session_"))
                ?.split(";", 1)[0] ?? "";
            const pair = () =>
              Effect.gen(function* () {
                const response = yield* Effect.promise(() =>
                  environment.handler(
                    postJson(
                      "/api/auth/pairing-token",
                      { scopes: ["orchestration:read"] },
                      { cookie },
                    ),
                    requestContext,
                  ),
                );
                expect(response.status).toBe(200);
                return ((yield* Effect.promise(() => response.json())) as { credential: string })
                  .credential;
              });
            const deniedGrant = yield* pair();
            expect(
              (yield* exchange(deniedGrant, sign("denied-scope"), "orchestration:operate")).status,
            ).toBe(400);
            expect(yield* markers()).toHaveLength(0);
            const proof = sign("valid-proof");
            const valid = yield* exchange(DEV_TOKEN, proof, "orchestration:read");
            expect(valid.status).toBe(200);
            const token = (yield* Effect.promise(() => valid.json())) as {
              token_type: string;
              scope: string;
              access_token: string;
            };
            expect(token).toMatchObject({ token_type: "DPoP", scope: "orchestration:read" });
            expect(yield* markers()).toHaveLength(1);
            const freshGrant = yield* pair();
            const replay = yield* exchange(freshGrant, proof);
            expect(replay.status).toBe(401);
            expect(replay.headers.get("www-authenticate")).toBe("DPoP");
            expect(yield* markers()).toHaveLength(1);
            // Replayed proofs must not consume an otherwise fresh one-time grant.
            expect((yield* exchange(freshGrant, sign("fresh-proof"))).status).toBe(200);
            expect(yield* markers()).toHaveLength(2);
            const concurrentProof = sign("concurrent-proof");
            const concurrent = yield* Effect.all(
              [exchange(DEV_TOKEN, concurrentProof), exchange(DEV_TOKEN, concurrentProof)],
              { concurrency: "unbounded" },
            );
            expect(concurrent.map((response) => response.status).sort()).toEqual([200, 401]);
            expect(yield* markers()).toHaveLength(3);
            const ticketProof = sign(
              "ticket-proof",
              "POST",
              "http://127.0.0.1/api/auth/websocket-ticket",
              token.access_token,
            );
            const ticket = () =>
              Effect.promise(() =>
                environment.handler(
                  postJson(
                    "/api/auth/websocket-ticket",
                    {},
                    {
                      host: "127.0.0.1",
                      authorization: `DPoP ${token.access_token}`,
                      dpop: ticketProof,
                    },
                  ),
                  requestContext,
                ),
              );
            expect((yield* ticket()).status).toBe(200);
            expect((yield* ticket()).status).toBe(401);
            expect(yield* markers()).toHaveLength(4);
            const grants = [yield* pair(), yield* pair()];
            const sharedProof = sign("concurrent-one-time-proof");
            const attempts = yield* Effect.all(
              grants.map((grant) => exchange(grant, sharedProof)),
              {
                concurrency: "unbounded",
              },
            );
            expect(attempts.map((response) => response.status).sort()).toEqual([200, 401]);
            const rejectedIndex = attempts.findIndex((response) => response.status === 401);
            expect(
              (yield* exchange(grants[rejectedIndex]!, sign("retry-one-time-proof"))).status,
            ).toBe(200);
            expect(yield* markers()).toHaveLength(6);
          }),
        (environment) => Effect.promise(() => environment.dispose()),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
