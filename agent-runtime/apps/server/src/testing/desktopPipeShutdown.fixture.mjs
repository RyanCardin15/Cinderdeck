import * as NodeFS from "node:fs";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { readBootstrapEnvelope } from "../bootstrap.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Receiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

const directory = process.argv[2];
NodeRuntime.runMain(
  Effect.scoped(
    Effect.gen(function* () {
      const envelope = yield* readBootstrapEnvelope(Schema.Struct({ mode: Schema.String }), 3);
      if (Option.isNone(envelope) || envelope.value.mode !== "desktop")
        return yield* Effect.die("Missing production bootstrap envelope");
      const config = yield* ServerConfig.ServerConfig;
      const receiver = yield* Receiver.make().pipe(
        Effect.provideService(ServerConfig.ServerConfig, { ...config, desktopTelemetryFd: 4 }),
      );
      yield* Effect.gen(function* () {
        while ((yield* receiver.health).status !== "healthy") yield* Effect.sleep("10 millis");
      }).pipe(Effect.timeout("2 seconds"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.appendFileSync(`${directory}/cleanup.txt`, "cleanup complete\n")),
      );
      yield* Effect.sync(() => process.stdout.write("ready\n"));
      if (process.argv[3] === "eof") {
        yield* Effect.gen(function* () {
          while ((yield* receiver.health).status !== "stopped") yield* Effect.sleep("10 millis");
        }).pipe(Effect.timeout("2 seconds"));
        yield* Effect.sync(() => process.stdout.write("eof observed\n"));
      }
      yield* Effect.never;
    }),
  ).pipe(
    Effect.provide(ServerSettings.layerTest()),
    Effect.provide(ServerConfig.layerTest(directory, directory)),
    Effect.provide(NodeServices.layer),
  ),
);
