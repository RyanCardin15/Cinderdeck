// @effect-diagnostics nodeBuiltinImport:off - An explicit integration smoke test, never a product startup path.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CinderdeckClient from "../../apps/server/src/deckhand/CinderdeckClient.ts";
const socketPath = process.argv[2];
if (!socketPath?.startsWith("/"))
  throw new Error("Pass an absolute, isolated Cinderdeck socket path.");
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const client = yield* CinderdeckClient.CinderdeckClient;
    const connection = yield* client.connect(socketPath, { channel: "development" });
    const snapshot = yield* client.snapshot(connection);
    const events = yield* client.events(connection, { after: snapshot.cursor, waitMs: 1 });
    return { hello: connection.hello, snapshot, events };
  }).pipe(Effect.provide(CinderdeckClient.layer.pipe(Layer.provide(NodeServices.layer)))),
);
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
