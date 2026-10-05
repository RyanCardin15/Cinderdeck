// @effect-diagnostics globalFetchInEffect:off - Isolated wire smoke fixtures use native HTTP/timer APIs and JSON error reports.
// @effect-diagnostics preferSchemaOverJson:off - Isolated wire smoke fixtures use native HTTP/timer APIs and JSON error reports.
// @effect-diagnostics nodeBuiltinImport:off - This opt-in smoke test owns only its isolated fixture lanes.
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import type * as Contracts from "@cinderdeck/contracts/deckhand/integration";
import * as CinderdeckClient from "../../apps/server/src/deckhand/CinderdeckClient.ts";
import * as CheckoutIdentity from "../../apps/server/src/deckhand/CheckoutIdentity.ts";
import * as ProcessRunner from "../../apps/server/src/processRunner.ts";
const decodeStamp = Schema.decodeUnknownSync(Schema.Struct({ sourceHash: Schema.String, commit: Schema.String }));
const socketPath = process.argv[2];
if (!socketPath?.startsWith("/")) throw new Error("Pass an isolated Cinderdeck socket path.");
const TestLayer = Layer.mergeAll(CinderdeckClient.layer, CheckoutIdentity.layer).pipe(
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const client = yield* CinderdeckClient.CinderdeckClient;
    const identity = yield* CheckoutIdentity.CheckoutIdentity;
    const fs = yield* FileSystem.FileSystem;
    const connection = yield* client.connect(socketPath, {
      channel: "development",
      clientID: "deckhand-operation-smoke",
    });
    const baseSnapshot = yield* client.snapshot(connection, { workspaceID: "payment" });
    const base = baseSnapshot.resources[0];
    const pendingReplay = yield* Effect.forkChild(
      client.events(connection, { after: baseSnapshot.cursor, waitMs: 25000 }),
    );
    NodeAssert.ok(base?.available && base.workspace);
    NodeAssert.ok(
      base.workspace.file.includes("/.deckhand/cinderdeck-smoke/"),
      "Refuse a live/user workspace",
    );
    const baseIdentities = yield* Effect.forEach(base.workspace.repos, (repo) =>
      identity.resolve(repo.path),
    );
    const receipts: Contracts.IntegrationOperationReceipt[] = [];
    const execute = (
      workspaceID: string,
      method: Contracts.IntegrationOperationInput["method"],
      args: Record<string, unknown>,
    ) =>
      Effect.gen(function* () {
        const resource = (yield* client.snapshot(connection, { workspaceID })).resources[0];
        NodeAssert.ok(resource?.available);
        const input: Contracts.IntegrationOperationInput = {
          operationKey: NodeCrypto.randomUUID(),
          installationID: connection.hello.installationID,
          workspaceID,
          generation: resource.generation,
          revision: resource.revision,
          method,
          arguments: { workspace: workspaceID, ...args },
        };
        const accepted = yield* client.submit(connection, input);
        const repeated = yield* client.submit(connection, input);
        NodeAssert.equal(
          repeated.id,
          accepted.id,
          "Duplicate submissions retrieve their original receipt",
        );
        for (let attempt = 0; attempt < 200; attempt++) {
          const receipt = yield* client.operation(connection, input.operationKey);
          if (!["pending", "running"].includes(receipt.state)) {
            NodeAssert.equal(receipt.state, "succeeded", JSON.stringify(receipt));
            receipts.push(receipt);
            return receipt;
          }
          yield* Effect.sleep("100 millis");
        }
        throw new Error("Operation remained pending; inspect its durable receipt before retrying.");
      });
    const lanes: string[] = [];
    const branches: string[] = [];
    const live: string[] = [];
    const runtime: unknown[] = [];
    try {
      for (const role of ["writer", "review", "verify"]) {
        const branch = "deckhand-test/" + role + "-" + NodeCrypto.randomUUID().slice(0, 8);
        branches.push(branch);
        const receipt = yield* execute("payment", "lane.create", {
          branch,
          start: false,
          setup: false,
        });
        const outcome = receipt.result as { workspace: { id: string } };
        const id = outcome.workspace.id;
        lanes.push(id);
        const lane = (yield* client.snapshot(connection, { workspaceID: id })).resources[0]
          ?.workspace;
        NodeAssert.ok(lane);
        NodeAssert.equal(lane.repos.length, 3);
        NodeAssert.ok(
          lane.repos.every((repo) => repo.path.includes("/.deckhand/cinderdeck-smoke/lanes/")),
          "Saved preferences must never move test worktrees out of the fixture root",
        );
        const physical = yield* Effect.forEach(lane.repos, (repo) => identity.resolve(repo.path));
        for (let index = 0; index < physical.length; index++) {
          NodeAssert.notEqual(physical[index]?.physicalId, baseIdentities[index]?.physicalId);
          NodeAssert.equal(
            physical[index]?.repositoryPhysicalId,
            baseIdentities[index]?.repositoryPhysicalId,
          );
          NodeAssert.equal(physical[index]?.branch, branch);
        }
        yield* execute(id, "services.start", {});
        live.push(id);
        const running = (yield* client.snapshot(connection, { workspaceID: id })).resources[0]
          ?.workspace;
        NodeAssert.ok(running?.services.every((service) => service.ready));
        NodeAssert.ok(running);
        const web = running.services.find((service) => service.name === "web")!;
        const api = running.services.find((service) => service.name === "api")!;
        const responses = yield* Effect.promise(async () => {
          const first = await fetch(web.url + "/api/payment?retry=0");
          const retry = await fetch(web.url + "/api/payment?retry=1");
          const frontendStamp = await fetch(web.url + "/stamp").then((response) => response.json()).then(decodeStamp);
          const apiStamp = await fetch(api.url + "/stamp").then((response) => response.json()).then(decodeStamp);
          NodeAssert.equal(first.status, 402);
          NodeAssert.equal(retry.status, 402, "The unrepaired scenario must fail consistently");
          return { first: first.status, retry: retry.status, frontendStamp, apiStamp };
        });
        const frontendRepo = lane.repos.find((repo) => repo.id === "frontend")!;
        const apiRepo = lane.repos.find((repo) => repo.id === "api")!;
        const frontendSource = yield* fs.readFile(frontendRepo.path + "/index.html");
        const apiSource = yield* fs.readFile(apiRepo.path + "/server.mjs");
        NodeAssert.equal(
          responses.frontendStamp.sourceHash,
          NodeCrypto.createHash("sha256").update(frontendSource).digest("hex"),
        );
        NodeAssert.equal(
          responses.apiStamp.sourceHash,
          NodeCrypto.createHash("sha256").update(apiSource).digest("hex"),
        );
        NodeAssert.equal(
          responses.frontendStamp.commit,
          physical[lane.repos.findIndex((repo) => repo.id === "frontend")]?.commit,
        );
        NodeAssert.equal(
          responses.apiStamp.commit,
          physical[lane.repos.findIndex((repo) => repo.id === "api")]?.commit,
        );
        runtime.push({ workspaceID: id, branch, physical, services: running.services, responses });
      }
      const inventory = yield* client.snapshot(connection);
      const services = inventory.resources
        .filter((resource) => lanes.includes(resource.workspaceID))
        .flatMap((resource) => resource.workspace?.services ?? []);
      NodeAssert.equal(
        new Set(services.map((service) => service.port)).size,
        6,
        "Every lane owns distinct service ports",
      );
      const replay = yield* Fiber.join(pendingReplay);
      NodeAssert.ok(
        replay.events.length > 0,
        "A pending replay connection must not block lane/service commands",
      );
      return {
        replay,
        installationID: connection.hello.installationID,
        lanes,
        branches,
        runtime,
        receipts,
      };
    } finally {
      for (const id of live.toReversed()) yield* execute(id, "services.stop", {});
    }
  }).pipe(Effect.provide(TestLayer)),
);
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
