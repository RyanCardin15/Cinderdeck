// @effect-diagnostics nodeBuiltinImport:off - Explicit isolated native fixture verification.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CinderdeckClient from "../../apps/server/src/deckhand/CinderdeckClient.ts";
import * as CheckoutIdentity from "../../apps/server/src/deckhand/CheckoutIdentity.ts";
import * as ProcessRunner from "../../apps/server/src/processRunner.ts";

const socketPath = process.argv[2];
const nativeBinary = process.argv[3];
if (!socketPath?.startsWith("/") || !nativeBinary?.startsWith("/"))
  throw new Error("Pass the isolated native fixture socket and binary.");
const layer = Layer.mergeAll(CinderdeckClient.layer, CheckoutIdentity.layer).pipe(
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const client = yield* CinderdeckClient.CinderdeckClient;
    const identity = yield* CheckoutIdentity.CheckoutIdentity;
    const runner = yield* ProcessRunner.ProcessRunner;
    const peer = yield* client.connect(socketPath, {
      channel: "development",
      clientID: "native-writer-smoke",
    });
    const resource = (yield* client.snapshot(peer, { workspaceID: "payment" })).resources[0];
    NodeAssert.ok(
      resource?.available && resource.workspace?.file.includes("/.deckhand/cinderdeck-smoke/"),
    );
    const repo = resource.workspace.repos.find((repo) => repo.id === "frontend");
    NodeAssert.ok(repo);
    const checkout = yield* identity.resolve(repo.path);
    const control = {
      id: NodeCrypto.randomUUID(),
      token: NodeCrypto.randomBytes(32).toString("hex"),
      installationID: peer.hello.installationID,
    };
    const input = {
      ...control,
      ownerID: "native-writer-smoke",
      workspaceID: resource.workspaceID,
      generation: resource.generation,
      revision: resource.revision,
      repos: [repo.id],
    };
    const held = yield* client.reserveWriter(peer, input);
    const output: Record<string, unknown> = {
      installationID: peer.hello.installationID,
      workspaceID: resource.workspaceID,
      generation: resource.generation,
    };
    try {
      NodeAssert.deepEqual(held.physicalIDs, [checkout.physicalId]);
      NodeAssert.deepEqual(yield* client.reservation(peer, control), held);
      const second = yield* client
        .reserveWriter(peer, {
          ...input,
          id: NodeCrypto.randomUUID(),
          token: NodeCrypto.randomBytes(32).toString("hex"),
        })
        .pipe(Effect.flip);
      NodeAssert.equal(second.code, "checkout_reserved");
      const blocked = yield* runner.run({
        command: nativeBinary,
        args: ["workspace", "task", "payment", "ownership_probe", "--wait", "--json"],
        env: { CINDERDECK_STACKS_SOCKET: socketPath },
        timeout: 15000,
      });
      NodeAssert.notEqual(blocked.code, 0);
      NodeAssert.match(blocked.stderr + blocked.stdout, /checkout_reserved/);
      output.physicalIdentityMatches = true;
      output.secondWriterRefused = true;
      output.nativeTaskRefused = true;
    } finally {
      const released = yield* client.releaseWriter(peer, control);
      NodeAssert.equal(released.state, "released");
      NodeAssert.equal((yield* client.releaseWriter(peer, control)).state, "released");
      output.released = true;
    }
    const allowed = yield* runner.run({
      command: nativeBinary,
      args: ["workspace", "task", "payment", "ownership_probe", "--wait", "--json"],
      env: { CINDERDECK_STACKS_SOCKET: socketPath },
      timeout: 15000,
    });
    NodeAssert.equal(allowed.code, 0, allowed.stderr);
    output.nativeTaskAllowedAfterRelease = true;
    return output;
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
