// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalTimersInEffect:off
// @effect-diagnostics preferSchemaOverJson:off
// Explicit acceptance test, never part of the unit test inventory or shipping helper.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { ExternalDebug, layerLive } from "./ExternalDebug.ts";

const receiptPath = NodePath.resolve(process.argv[2] ?? ".deckhand/mac-external-test/receipt.json");
const receipt = async () =>
  JSON.parse(await NodeFSP.readFile(receiptPath, "utf8")) as {
    pid: number;
    windowID: number;
    count: number;
    note: string;
  };
const baseline = await receipt();
const actor = "mac-native-fixture-acceptance";
const note = `Harness native acceptance ${baseline.count + 1}`;
async function waitForReceipt(predicate: (value: Awaited<ReturnType<typeof receipt>>) => boolean) {
  if (predicate(await receipt())) return;
  const signal = AbortSignal.timeout(8000);
  for await (const event of NodeFSP.watch(NodePath.dirname(receiptPath), { signal })) {
    if (event.filename !== NodePath.basename(receiptPath)) continue;
    try {
      if (predicate(await receipt())) return;
    } catch {
      /* atomic replacement in progress */
    }
  }
  throw new Error("Fixture did not acknowledge native input");
}
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* ExternalDebug;
      const targets = yield* service.discover({ endpoint: "mac://local" });
      const main = targets.find(
        (target) =>
          target.id === `mac:${baseline.pid}:${baseline.windowID}` &&
          target.title === "Mac WebKit Test Host — Office simulated",
      );
      const inspector = targets.find(
        (target) =>
          target.id.startsWith(`mac:${baseline.pid}:`) && target.title.startsWith("Web Inspector"),
      );
      NodeAssert.ok(
        main && inspector,
        "Only this acceptance fixture and its real Inspector may be selected",
      );
      const host = yield* service.attach(actor, { endpoint: "mac://local", targetId: main.id });
      const tools = yield* service.attach(actor, {
        endpoint: "mac://local",
        targetId: inspector.id,
      });
      const during = yield* service.discover({ endpoint: "mac://local" });
      NodeAssert.ok(during.some((target) => target.id === main.id));
      let images = 0,
        deltas = 0;
      for (const session of [host, tools]) {
        let imageSequence: number | undefined;
        for (let index = 0; index < 6; index++) {
          const snapshot = yield* service.read(actor, {
            sessionId: session.sessionId,
            after: 0,
            screenshot: true,
            ...(imageSequence === undefined ? {} : { afterImage: imageSequence }),
          });
          NodeAssert.equal(snapshot.session.state, "connected", JSON.stringify(snapshot.events));
          NodeAssert.equal(snapshot.imageUnavailable, false);
          if (snapshot.image) {
            const image = Buffer.from(snapshot.image, "base64");
            NodeAssert.equal(image.readUInt16BE(0), 0xffd8, "Actual native JPEG frame");
            images++;
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(
                  NodePath.dirname(receiptPath),
                  `${session === host ? "host" : "inspector"}.jpg`,
                ),
                image,
              ),
            );
          } else deltas++;
          imageSequence = snapshot.imageSequence;
          yield* Effect.sleep("400 millis");
        }
      }
      NodeAssert.ok(deltas > 0, "Idle native frames should not be retransmitted");
      yield* service.command(actor, {
        sessionId: host.sessionId,
        action: "click",
        x: 0.23,
        y: 0.55,
      });
      yield* Effect.promise(() => waitForReceipt((value) => value.count === baseline.count + 1));
      yield* service.command(actor, {
        sessionId: host.sessionId,
        action: "click",
        x: 0.25,
        y: 0.67,
      });
      yield* service.command(actor, {
        sessionId: host.sessionId,
        action: "key",
        key: "a",
        modifiers: ["meta"],
      });
      yield* service.command(actor, { sessionId: host.sessionId, action: "type", text: note });
      yield* Effect.promise(() => waitForReceipt((value) => value.note === note));
      yield* service.detach(actor, { sessionId: host.sessionId });
      const remaining = yield* service.read(actor, {
        sessionId: tools.sessionId,
        after: 0,
        screenshot: true,
      });
      NodeAssert.equal(remaining.session.state, "connected");
      NodeAssert.ok(remaining.image, "Detaching one mirror must preserve the other stream");
      yield* service.detach(actor, { sessionId: tools.sessionId });
      const after = yield* service.discover({ endpoint: "mac://local" });
      NodeAssert.ok(
        after.some((target) => target.id === main.id) &&
          after.some((target) => target.id === inspector.id),
        "Detach must preserve both native windows",
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(NodePath.dirname(receiptPath), "native-acceptance.json"),
          JSON.stringify(
            {
              passed: true,
              realWebKit: true,
              officeSimulated: true,
              frames: images,
              unchangedReads: deltas,
              nativeClick: true,
              nativeText: true,
              discoveryPreservedStreams: true,
              detachPreservedOtherStream: true,
              detachPreservedWindows: true,
            },
            null,
            2,
          ),
        ),
      );
      yield* Effect.log(
        "Native Mac acceptance passed: paired JPEG captures, frame deltas, actual click/text receipts, and host-preserving detach. Office APIs were simulated.",
      );
    }).pipe(Effect.provide(layerLive)),
  ),
);
