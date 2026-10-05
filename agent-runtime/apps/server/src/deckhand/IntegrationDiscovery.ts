// @effect-diagnostics nodeBuiltinImport:off - Local discovery follows the native application's documented state path.
import * as NodeOS from "node:os";
import { HostProcessPlatform } from "@cinderdeck/shared/hostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import * as CinderdeckClient from "./CinderdeckClient.ts";

export class DiscoveryConfig extends Context.Service<
  DiscoveryConfig,
  {
    readonly channel: "development" | "release";
    readonly socketPath?: string;
    readonly statePath: string;
  }
>()("@cinderdeck/server/deckhand/IntegrationDiscovery/DiscoveryConfig") {}
export const configLayer = Layer.effect(
  DiscoveryConfig,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const configuredChannel = yield* Config.Literals(
      ["development", "release"],
      "DECKHAND_CINDERDECK_CHANNEL",
    ).pipe(Config.withDefault("release"));
    const inheritedSocket = yield* Config.option(Config.String("CINDERDECK_NATIVE_SOCKET_PATH"));
    const inheritedChannel = yield* Config.option(Config.String("CINDERDECK_NATIVE_CHANNEL"));
    const nativeHost = yield* Config.String("CINDERDECK_NATIVE_HOST").pipe(Config.withDefault("0"));
    const channel = nativeHost === "1" && Option.isSome(inheritedChannel) && ["development","release"].includes(inheritedChannel.value)
      ? inheritedChannel.value as "development" | "release" : configuredChannel;
    const configuredSocket = yield* Config.option(Config.String("DECKHAND_CINDERDECK_SOCKET"));
    const socket = nativeHost === "1" && Option.isSome(inheritedSocket) ? inheritedSocket : configuredSocket;
    const state = yield* Config.option(Config.String("DECKHAND_CINDERDECK_STATE"));
    return DiscoveryConfig.of({
      channel,
      ...(Option.isSome(socket) ? { socketPath: socket.value } : {}),
      statePath: Option.getOrElse(state, () =>
        path.join(
          NodeOS.homedir(),
          "Library/Application Support/Cinderdeck",
          channel === "release" ? "Stacks" : "Stacks-Debug",
          "state.json",
        ),
      ),
    });
  }),
);
export class HostIdentity extends Context.Service<
  HostIdentity,
  {
    readonly get: Effect.Effect<string, CinderdeckClient.BridgeError>;
  }
>()("@cinderdeck/server/deckhand/IntegrationDiscovery/HostIdentity") {}
export const hostLayer = Layer.effect(
  HostIdentity,
  Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const platform = yield* HostProcessPlatform;
    const get = yield* Effect.cachedWithTTL(
      Effect.gen(function* () {
        if (platform !== "darwin")
          return yield* new CinderdeckClient.BridgeError({
            reason: "unavailable",
            code: "unsupported_platform",
          });
        const result = yield* runner
          .run({
            command: "/usr/sbin/ioreg",
            args: ["-rd1", "-c", "IOPlatformExpertDevice"],
            maxOutputBytes: 65536,
            timeout: Duration.seconds(5),
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new CinderdeckClient.BridgeError({
                  reason: "unavailable",
                  code: "host_identity_unavailable",
                  cause,
                }),
            ),
          );
        const match = /"IOPlatformUUID"\s*=\s*"([0-9a-f-]{36})"/i.exec(result.stdout);
        if (result.code !== 0 || result.stdoutTruncated || !match?.[1])
          return yield* new CinderdeckClient.BridgeError({
            reason: "unavailable",
            code: "host_identity_unavailable",
          });
        return match[1].toLowerCase();
      }),
      (exit) => (Exit.isSuccess(exit) ? "Infinity" : 0),
    );
    return HostIdentity.of({ get });
  }),
);
export class IntegrationDiscovery extends Context.Service<
  IntegrationDiscovery,
  {
    readonly locate: Effect.Effect<
      {
        readonly socketPath: string;
        readonly hostID: string;
        readonly channel: "development" | "release";
      },
      CinderdeckClient.BridgeError
    >;
  }
>()("@cinderdeck/server/deckhand/IntegrationDiscovery") {}
const isBridgeError = Schema.is(CinderdeckClient.BridgeError);
const decodeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ socket: Schema.String, appRunning: Schema.Boolean })),
);
export const layer = Layer.effect(
  IntegrationDiscovery,
  Effect.gen(function* () {
    const config = yield* DiscoveryConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const identity = yield* HostIdentity;
    const locate = Effect.gen(function* () {
      const hostID = yield* identity.get;
      if (config.socketPath) {
        if (!path.isAbsolute(config.socketPath))
          return yield* new CinderdeckClient.BridgeError({ reason: "invalid_request" });
        return { socketPath: config.socketPath, hostID, channel: config.channel };
      }
      if (!path.isAbsolute(config.statePath))
        return yield* new CinderdeckClient.BridgeError({ reason: "invalid_request" });
      const parent = yield* fs.stat(path.dirname(config.statePath));
      const file = yield* fs.stat(config.statePath);
      if (
        parent.type !== "Directory" ||
        (parent.mode & 0o077) !== 0 ||
        Option.getOrNull(parent.uid) !== NodeOS.userInfo().uid ||
        file.type !== "File" ||
        Option.getOrNull(file.uid) !== NodeOS.userInfo().uid ||
        file.size > 4 * 1024 * 1024
      )
        return yield* new CinderdeckClient.BridgeError({ reason: "unauthorized_socket" });
      const state = yield* decodeState(yield* fs.readFileString(config.statePath));
      if (!state.appRunning)
        return yield* new CinderdeckClient.BridgeError({ reason: "unavailable" });
      if (!path.isAbsolute(state.socket))
        return yield* new CinderdeckClient.BridgeError({ reason: "invalid_response" });
      return { socketPath: state.socket, hostID, channel: config.channel };
    }).pipe(
      Effect.mapError((cause) =>
        isBridgeError(cause)
          ? cause
          : new CinderdeckClient.BridgeError({ reason: "unavailable", cause }),
      ),
    );
    return IntegrationDiscovery.of({ locate });
  }),
);
