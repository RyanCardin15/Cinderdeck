import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { ManagedSessionsInput } from "./deckhand/rpc.js";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WsRpcGroup, WsSubscribeServerConfigRpc } from "./rpc.ts";

/**
 * The client always sends `environmentThemes`, including to servers built
 * before the field existed, whose payload schema was an empty struct. What
 * makes that safe is that such a schema accepts the request rather than
 * rejecting it -- an error here would take down the config subscription.
 */
describe("subscribeServerConfig payload compatibility", () => {
  it("is accepted by a server whose schema predates the field", () => {
    const oldServerPayload = Schema.Struct({});
    const decoded = Schema.decodeExit(oldServerPayload)({ environmentThemes: true });
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("is carried by a server that declares it", () => {
    const decoded = Schema.decodeSync(WsSubscribeServerConfigRpc.payloadSchema)({
      environmentThemes: true,
    });
    expect(decoded).toEqual({ environmentThemes: true });
  });

  it("stays optional, so a client that never sends it still subscribes", () => {
    const decoded = Schema.decodeSync(WsSubscribeServerConfigRpc.payloadSchema)({});
    expect(decoded).toEqual({});
  });
});

describe("WebSocket RPC contracts", () => {
  it("exposes only the V2 orchestration transport surface", () => {
    const methods = [...WsRpcGroup.requests.keys()];

    expect(methods).toEqual(expect.arrayContaining(Object.values(ORCHESTRATION_V2_WS_METHODS)));
    expect(methods.filter((method) => method.startsWith("orchestrationV1."))).toEqual([]);
  });

  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });
});

const decodeManagedSessions = Schema.decodeUnknownSync(ManagedSessionsInput);
const decodeManagedSessionsExit = Schema.decodeUnknownExit(ManagedSessionsInput);

describe("managed agent paging compatibility", () => {
  const input = { installationID: "installation", workspaceID: "lane", generation: 7, limit: 20 };
  it("accepts legacy page-zero clients and bounded explicit pages", () => {
    const decode = decodeManagedSessions;
    expect(decode(input).offset).toBeUndefined();
    expect(decode({ ...input, offset: 0 }).offset).toBe(0);
    expect(decode({ ...input, offset: 20 }).offset).toBe(20);
    expect(decode({ ...input, offset: 10000 }).offset).toBe(10000);
  });
  it("refuses negative, excessive and non-integer offsets and unbounded page sizes", () => {
    const decode = decodeManagedSessionsExit;
    for (const offset of [-1, 10001, 1.5])
      expect(Exit.isFailure(decode({ ...input, offset }))).toBe(true);
    expect(Exit.isFailure(decode({ ...input, limit: 21 }))).toBe(true);
  });
});
