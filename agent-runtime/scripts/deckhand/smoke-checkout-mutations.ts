// @effect-diagnostics globalFetch:off - Isolated wire smoke fixtures use native HTTP/timer APIs and JSON error reports.
// @effect-diagnostics globalTimers:off - Isolated wire smoke fixtures use native HTTP/timer APIs and JSON error reports.
// @effect-diagnostics preferSchemaOverJson:off - Isolated wire smoke fixtures use native HTTP/timer APIs and JSON error reports.
// @effect-diagnostics nodeBuiltinImport:off - Explicit isolated native/Git smoke verification.
import * as Schema from "effect/Schema";
import * as Rpc from "../../packages/contracts/src/deckhand/rpc.ts";
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@cinderdeck/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CinderdeckClient from "../../apps/server/src/deckhand/CinderdeckClient.ts";
import * as CheckoutIdentity from "../../apps/server/src/deckhand/CheckoutIdentity.ts";
import * as GitMutationPolicy from "../../apps/server/src/deckhand/GitMutationPolicy.ts";
import * as ProcessRunner from "../../apps/server/src/processRunner.ts";
import * as GitVcsDriver from "../../apps/server/src/vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../apps/server/src/vcs/VcsProcess.ts";
const decodeView = Schema.decodeUnknownEffect(Rpc.IntegrationView);
const socketPath = process.argv[2];
const nativeBinary = process.argv[3];
const database = process.argv[4];
if (
  !socketPath?.startsWith("/tmp/deckhand-") ||
  !nativeBinary?.startsWith("/tmp/deckhand-") ||
  !database?.includes("/.deckhand/")
)
  throw new Error(
    "Pass only the isolated fixture socket, native binary and Cinderdeck smoke database.",
  );
const serverUrl = process.env.DECKHAND_SMOKE_SERVER_URL;
const bootstrap = process.env.DECKHAND_SMOKE_BOOTSTRAP;
if (!serverUrl?.startsWith("http://127.0.0.1:") || !bootstrap)
  throw new Error("Pass the captured isolated server URL and private smoke bootstrap credential.");
const rpc = async (tag: string, payload: unknown): Promise<{ _tag: string; value?: unknown }> => {
  const tokenResponse = await fetch(serverUrl + "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: bootstrap,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "isolated mutation smoke",
    }),
  });
  if (!tokenResponse.ok) throw new Error(`Smoke token exchange failed (${tokenResponse.status}).`);
  const auth = (await tokenResponse.json()) as { access_token: string };
  const ticketResponse = await fetch(serverUrl + "/api/auth/websocket-ticket", {
    method: "POST",
    headers: { authorization: `Bearer ${auth.access_token}` },
  });
  if (!ticketResponse.ok) throw new Error(`Smoke socket ticket failed (${ticketResponse.status}).`);
  const { ticket } = (await ticketResponse.json()) as { ticket: string };
  const url = new URL(serverUrl + "/ws");
  url.protocol = "ws:";
  url.searchParams.set("orchestrationProtocol", "2");
  url.searchParams.set("wsTicket", ticket);
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Smoke RPC deadline exceeded."));
    }, 15000);
    socket.addEventListener("open", () =>
      socket.send(
        JSON.stringify({
          _tag: "Request",
          id: "1",
          tag,
          payload,
          headers: [],
        }),
      ),
    );
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message._tag !== "Exit" || message.requestId !== "1") return;
      clearTimeout(timer);
      socket.close();
      resolve(message.exit);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error("Smoke RPC connection failed."));
    });
  });
};
const layer = Layer.mergeAll(
  GitMutationPolicy.layerLive,
  CinderdeckClient.layer,
  CheckoutIdentity.layer.pipe(Layer.provide(ProcessRunner.layer)),
  VcsProcess.layer,
).pipe(
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: database })),
  Layer.provideMerge(NodeServices.layer),
);
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const client = yield* CinderdeckClient.CinderdeckClient;
    const identities = yield* CheckoutIdentity.CheckoutIdentity;
    const runner = yield* ProcessRunner.ProcessRunner;
    const fs = yield* FileSystem.FileSystem;
    const sql = yield* SqlClient.SqlClient;
    const policy = yield* GitMutationPolicy.GitMutationPolicy;
    NodeAssert.equal(policy.managed, true);
    const driver = yield* GitVcsDriver.makeVcsDriverShape();
    const peer = yield* client.connect(socketPath, {
      channel: "development",
      clientID: "checkout-mutation-smoke",
    });
    const resource = (yield* client.snapshot(peer, { workspaceID: "payment" })).resources[0];
    NodeAssert.ok(
      resource?.available && resource.workspace?.file.includes("/.deckhand/cinderdeck-smoke/"),
    );
    NodeAssert.ok(resource.workspace);
    const repo = resource.workspace.repos.find((repo) => repo.id === "frontend");
    NodeAssert.ok(repo);
    const checkout = yield* identities.resolve(repo.path);
    const refreshed = yield* Effect.promise(() => rpc("deckhand.refresh", {}));
    NodeAssert.equal(refreshed._tag, "Success");
    const overview = yield* Effect.promise(() =>
      rpc("deckhand.overview", { offset: 0, limit: 100 }),
    );
    NodeAssert.equal(overview._tag, "Success");
    const catalog = yield* decodeView(overview.value);
    NodeAssert.ok(
      catalog.resources.some((item) => item.workspaceID === resource.workspaceID && item.available),
    );
    const staleCreate = yield* Effect.promise(() =>
      rpc("deckhand.operation.submit", {
        operationKey: NodeCrypto.randomUUID(),
        installationID: peer.hello.installationID,
        workspaceID: resource.workspaceID,
        generation: resource.generation + 1,
        revision: resource.revision,
        method: "lane.create",
        arguments: {
          workspace: resource.workspaceID,
          branch: `deckhand-backend-probe/${NodeCrypto.randomUUID()}`,
          start: false,
          setup: false,
        },
      }),
    );
    NodeAssert.equal(
      staleCreate._tag,
      "Failure",
      "Backend lane creation must reject stale native generations before effects",
    );
    NodeAssert.match(JSON.stringify(staleCreate), /stale_revision/);

    const input = {
      installationID: peer.hello.installationID,
      physicalID: checkout.physicalId,
      repositoryPhysicalID: checkout.repositoryPhysicalId,
      physicalIDs: [checkout.physicalId],
      sharedRefs: false,
    };
    const exact = yield* client.checkoutContexts(peer, input);
    NodeAssert.ok(
      exact.contexts.some(
        (item) => item.workspaceID === "payment" && item.physicalIDs.includes(checkout.physicalId),
      ),
    );
    const worktrees = yield* runner.run({
      command: "git",
      args: ["-C", checkout.root, "worktree", "list", "--porcelain", "-z"],
    });
    NodeAssert.equal(worktrees.code, 0);
    const physicalIDs = yield* Effect.forEach(
      worktrees.stdout.split("\0\0").filter(Boolean),
      (record) =>
        identities
          .resolve(record.split("\0")[0]!.slice(9))
          .pipe(Effect.map((item) => item.physicalId)),
    );
    const shared = yield* client.checkoutContexts(peer, {
      ...input,
      sharedRefs: true,
      physicalIDs,
    });
    NodeAssert.ok(
      shared.contexts.length > exact.contexts.length,
      "Linked native lanes must be included in shared-ref ownership",
    );
    const control = {
      id: NodeCrypto.randomUUID(),
      token: NodeCrypto.randomBytes(32).toString("hex"),
      installationID: peer.hello.installationID,
    };
    const writer = {
      ...control,
      ownerID: "resident-smoke",
      workspaceID: resource.workspaceID,
      generation: resource.generation,
      revision: resource.revision,
      repos: [repo.id],
    };
    const branch = `deckhand-mutation-probe/${NodeCrypto.randomUUID()}`;
    const command = {
      operation: "deckhand.ownership.smoke",
      cwd: checkout.root,
      args: ["branch", branch],
    };
    const rpcBranch = branch + "-rpc";
    let rpcCreated = false;
    yield* client.reserveWriter(peer, writer);
    try {
      const blocked = yield* driver.execute(command).pipe(Effect.flip);
      NodeAssert.match(blocked.message, /active or uncertain writer/);
      NodeAssert.equal(
        (yield* driver.execute({ ...command, args: ["branch", "--list", branch] })).stdout,
        "",
      );
      const blockedRpc = yield* Effect.promise(() =>
        rpc("vcs.createRef", { cwd: checkout.root, refName: rpcBranch, switchRef: false }),
      );
      rpcCreated = blockedRpc._tag === "Success";
      NodeAssert.equal(
        blockedRpc._tag,
        "Failure",
        "The per-connection production Git driver must retain the ownership policy",
      );
      NodeAssert.match(JSON.stringify(blockedRpc), /active or uncertain writer/);
    } finally {
      NodeAssert.equal((yield* client.releaseWriter(peer, control)).state, "released");
      if (rpcCreated) yield* driver.execute({ ...command, args: ["branch", "-D", rpcBranch] });
    }
    try {
      const allowedRpc = yield* Effect.promise(() =>
        rpc("vcs.createRef", { cwd: checkout.root, refName: rpcBranch, switchRef: false }),
      );
      rpcCreated = allowedRpc._tag === "Success";
      NodeAssert.equal(
        allowedRpc._tag,
        "Success",
        "An authenticated production Git request must work after release",
      );
    } finally {
      if (rpcCreated) yield* driver.execute({ ...command, args: ["branch", "-D", rpcBranch] });
    }
    let created = false;
    try {
      yield* driver.execute(command);
      created = true;
      NodeAssert.match(
        (yield* driver.execute({ ...command, args: ["branch", "--list", branch] })).stdout,
        new RegExp(branch),
      );
    } finally {
      if (created) yield* driver.execute({ ...command, args: ["branch", "-D", branch] });
    }
    let refusedNative = false;
    yield* policy.restore(
      checkout.root,
      Effect.gen(function* () {
        const blocked = yield* runner.run({
          command: nativeBinary,
          args: ["workspace", "task", "payment", "ownership_probe", "--wait", "--json"],
          env: { CINDERDECK_STACKS_SOCKET: socketPath },
          timeout: 15000,
        });
        NodeAssert.notEqual(blocked.code, 0);
        NodeAssert.match(blocked.stdout + blocked.stderr, /checkout_reserved/);
        refusedNative = true;
      }),
    );
    const allowed = yield* runner.run({
      command: nativeBinary,
      args: ["workspace", "task", "payment", "ownership_probe", "--wait", "--json"],
      env: { CINDERDECK_STACKS_SOCKET: socketPath },
      timeout: 15000,
    });
    NodeAssert.equal(allowed.code, 0, allowed.stderr);
    const remaining =
      yield* sql`SELECT id FROM deckhand_native_writer_intents WHERE state <> 'released'`;
    NodeAssert.equal(remaining.length, 0);
    NodeAssert.equal(
      (yield* sql`SELECT id FROM deckhand_writer_requests WHERE state <> 'released'`).length,
      0,
    );
    NodeAssert.equal(
      (yield* driver.execute({ ...command, args: ["branch", "--list", branch] })).stdout,
      "",
    );
    // No source files, default branch, services, or provider conversations are changed.
    NodeAssert.ok(yield* fs.exists(checkout.root));
    return {
      installationID: peer.hello.installationID,
      workspaceID: resource.workspaceID,
      exactContexts: exact.contexts.length,
      sharedContexts: shared.contexts.length,
      nativeResidentRefusedGit: true,
      authenticatedBackendInventory: true,
      authenticatedBackendRefusedStaleCreate: true,
      authenticatedProductionRpcRefusedGit: true,
      authenticatedProductionRpcAllowedAfterRelease: true,
      branchAllowedAfterRelease: true,
      probeBranchRemoved: true,
      nativeTaskRefusedDuringFileReservation: refusedNative,
      nativeTaskAllowedAfterRelease: true,
      unreleasedDeckhandClaims: remaining.length,
    };
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
