import {
  AuthStandardClientScopes,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@cinderdeck/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import * as EnvironmentRegistry from "./registry.ts";

import { remoteHttpClientLayer } from "../rpc/http.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import { BearerConnectionCredential, BearerConnectionProfile } from "./catalog.ts";
import { BearerConnectionTarget, type NetworkStatus } from "./model.ts";
import { prepareBearerConnectionUpdate, preparePairingRegistration } from "./onboarding.ts";

const CLIENT_PRESENTATION_LAYER = Layer.succeed(
  ClientCapabilities.ClientPresentation,
  ClientCapabilities.ClientPresentation.of({
    metadata: {
      label: "Cinderdeck Test",
      deviceType: "desktop",
      os: "Test OS",
    },
    scopes: AuthStandardClientScopes,
  }),
);

function pairingHttpLayer(
  calls: Array<{ readonly url: string; readonly init: RequestInit }>,
  options?: {
    readonly failDescriptor?: boolean;
    readonly protocolVersion?: number;
    readonly selfUpdate?: boolean;
    readonly saved?: ConnectionCatalogEntry;
  },
) {
  const fetchFn = ((input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });

    if (url.endsWith("/.well-known/t3/environment")) {
      if (options?.failDescriptor === true) {
        return Promise.resolve(
          Response.json({ message: "descriptor unavailable" }, { status: 503 }),
        );
      }
      return Promise.resolve(
        Response.json({
          environmentId: "environment-paired",
          label: "Paired environment",
          platform: {
            os: "linux",
            arch: "x64",
          },
          serverVersion: "0.0.0-test",
          orchestrationProtocolVersion: options?.protocolVersion ?? ORCHESTRATION_PROTOCOL_VERSION,
          capabilities: {
            repositoryIdentity: true,
            ...(options?.selfUpdate === true ? { serverSelfUpdate: "boot-service" } : {}),
          },
        }),
      );
    }

    if (url.endsWith("/oauth/token")) {
      return Promise.resolve(
        Response.json({
          access_token: "bearer-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: AuthStandardClientScopes.join(" "),
        }),
      );
    }

    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) satisfies typeof fetch;

  const registryLayer = Layer.effect(
    EnvironmentRegistry.EnvironmentRegistry,
    Effect.gen(function* () {
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(new Map(options?.saved ? [[options.saved.target.environmentId, options.saved]] : []));
      const unused = () => Effect.die("Unexpected registry operation");
      return EnvironmentRegistry.EnvironmentRegistry.of({
        entries,
        networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
        start: Effect.void,
        register: unused,
        registerPlatform: unused,
        reconcilePlatform: unused,
        remove: unused,
        removeRelayEnvironments: unused,
        retryNow: unused,
        setEnabled: unused,
        setCompatibility: unused,
        state: unused,
        stateChanges: () => Stream.die("Unexpected registry operation"),
        run: unused,
        runStream: () => Stream.die("Unexpected registry operation"),
        followStream: () => Stream.die("Unexpected registry operation"),
      });
    }),
  );
  return Layer.mergeAll(remoteHttpClientLayer(fetchFn), registryLayer);
}

describe("connection onboarding", () => {
  it.effect("prepares a persisted bearer registration from pairing details", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(Effect.provide(Layer.mergeAll(CLIENT_PRESENTATION_LAYER, pairingHttpLayer(calls))));

      expect(registration).toMatchObject({
        _tag: "BearerConnectionRegistration",
        target: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired",
        },
        profile: {
          environmentId: "environment-paired",
          label: "Paired environment",
          connectionId: "bearer:environment-paired",
          httpBaseUrl: "https://remote.example.test/",
          wsBaseUrl: "wss://remote.example.test/",
        },
        credential: {
          token: "bearer-token",
        },
      });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
        "https://remote.example.test/oauth/token",
      ]);

      const tokenRequest = calls.find((call) => call.url.endsWith("/oauth/token"));
      const tokenBody =
        tokenRequest?.init.body instanceof Uint8Array
          ? new TextDecoder().decode(tokenRequest.init.body)
          : String(tokenRequest?.init.body);
      const tokenParams = new URLSearchParams(tokenBody);
      expect(tokenParams.get("subject_token")).toBe("pairing-token");
      expect(tokenParams.get("scope")).toBe(AuthStandardClientScopes.join(" "));
      expect(tokenParams.get("client_label")).toBe("Cinderdeck Test");
    }),
  );

  it.effect.each([
    ["https://remote.example.test", true],
    ["https://attacker.example.test", false],
    ["https://remote.example.test:8443", false],
    ["https://remote.example.test/other", false],
  ] as const)("checks saved address %s before spending a pairing code", ([savedAddress, allowed]) =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const environmentId = EnvironmentId.make("environment-paired");
      const profile = new BearerConnectionProfile({
        connectionId: "saved-connection",
        environmentId,
        label: "Saved environment",
        httpBaseUrl: savedAddress,
        wsBaseUrl: savedAddress.replace("https:", "wss:"),
      });
      const result = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            CLIENT_PRESENTATION_LAYER,
            pairingHttpLayer(calls, {
              saved: {
                target: new BearerConnectionTarget({
                  environmentId,
                  label: "Saved environment",
                  connectionId: "saved-connection",
                }),
                profile: Option.some(profile),
                enabled: true,
              },
            }),
          ),
        ),
        Effect.result,
      );
      expect(result._tag).toBe(allowed ? "Success" : "Failure");
      expect(calls.map((call) => call.url)).toEqual(
        allowed
          ? [
              "https://remote.example.test/.well-known/t3/environment",
              "https://remote.example.test/oauth/token",
            ]
          : ["https://remote.example.test/.well-known/t3/environment"],
      );
    }),
  );

  it.effect("rejects an incompatible server without consuming the pairing credential", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            CLIENT_PRESENTATION_LAYER,
            pairingHttpLayer(calls, { protocolVersion: ORCHESTRATION_PROTOCOL_VERSION + 1 }),
          ),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "unsupported" });
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("pairs an outdated server so it can be updated from this client", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const registration = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            CLIENT_PRESENTATION_LAYER,
            pairingHttpLayer(calls, {
              protocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1,
              selfUpdate: true,
            }),
          ),
        ),
      );
      expect(registration.target.environmentId).toBe("environment-paired");
      expect(calls.map((call) => call.url)).toContain("https://remote.example.test/oauth/token");
    }),
  );

  it.effect("refuses an outdated server that cannot update itself", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            CLIENT_PRESENTATION_LAYER,
            pairingHttpLayer(calls, { protocolVersion: ORCHESTRATION_PROTOCOL_VERSION - 1 }),
          ),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({ reason: "unsupported" });
      expect(error).not.toHaveProperty("serverUpdateRequired");
      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("does not consume a pairing credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];

      yield* preparePairingRegistration({
        host: "remote.example.test",
        pairingCode: "pairing-token",
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            CLIENT_PRESENTATION_LAYER,
            pairingHttpLayer(calls, { failDescriptor: true }),
          ),
        ),
        Effect.flip,
      );

      expect(calls.map((call) => call.url)).toEqual([
        "https://remote.example.test/.well-known/t3/environment",
      ]);
    }),
  );

  it.effect("rejects invalid pairing details before making a request", () =>
    Effect.gen(function* () {
      const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
      const error = yield* preparePairingRegistration({
        host: "",
        pairingCode: "",
      }).pipe(
        Effect.provide(Layer.mergeAll(CLIENT_PRESENTATION_LAYER, pairingHttpLayer(calls))),
        Effect.flip,
      );

      expect(error).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "configuration",
        message: "Enter a backend URL.",
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("updates bearer metadata while preserving the credential and identity", () =>
    Effect.gen(function* () {
      const environmentId = EnvironmentId.make("environment-paired");
      const registration = yield* prepareBearerConnectionUpdate({
        input: {
          environmentId,
          label: "  Renamed environment  ",
          httpBaseUrl: "http://100.65.180.100:3773/path",
        },
        entry: Option.some({
          target: new BearerConnectionTarget({
            environmentId,
            label: "Old label",
            connectionId: "bearer:environment-paired",
          }),
          profile: Option.some(
            new BearerConnectionProfile({
              connectionId: "bearer:environment-paired",
              environmentId,
              label: "Old label",
              httpBaseUrl: "http://old.example.test/",
              wsBaseUrl: "ws://old.example.test/",
            }),
          ),
          enabled: true,
        }),
        credential: Option.some(new BearerConnectionCredential({ token: "bearer-token" })),
      });

      expect(registration).toMatchObject({
        target: {
          environmentId,
          label: "Renamed environment",
          connectionId: "bearer:environment-paired",
        },
        profile: {
          environmentId,
          label: "Renamed environment",
          httpBaseUrl: "http://100.65.180.100:3773/",
          wsBaseUrl: "ws://100.65.180.100:3773/",
        },
        credential: { token: "bearer-token" },
      });
    }),
  );
});
