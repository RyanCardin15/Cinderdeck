// @effect-diagnostics nodeBuiltinImport:off - This adapter owns the same-host Unix transport.
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as Contracts from "@t3tools/contracts/deckhand/integration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class BridgeError extends Schema.TaggedError<BridgeError>()("BridgeError", {
  reason: Schema.Literals([
    "unavailable",
    "unauthorized_socket",
    "timeout",
    "invalid_response",
    "peer_rejected",
    "invalid_request",
    "unsupported_capability",
    "stale_binding",
  ]),
  code: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Cinderdeck connection ${this.reason}${this.code ? ` (${this.code})` : ""}.`;
  }
}
interface Connection {
  readonly socketPath: string;
  readonly hello: Contracts.IntegrationHello;
  readonly clientID?: string;
}
interface ExpectedIdentity {
  readonly installationID?: string;
  readonly executionHostID?: string;
  readonly channel: "development" | "release";
  readonly clientID?: string;
}
export class CinderdeckClient extends Context.Service<
  CinderdeckClient,
  {
    readonly connect: (
      socketPath: string,
      expected: ExpectedIdentity,
    ) => Effect.Effect<Connection, BridgeError>;
    readonly submit: (
      connection: Connection,
      input: Contracts.IntegrationOperationInput,
    ) => Effect.Effect<Contracts.IntegrationOperationReceipt, BridgeError>;
    readonly operation: (
      connection: Connection,
      operationKey: string,
    ) => Effect.Effect<Contracts.IntegrationOperationReceipt, BridgeError>;
    readonly snapshot: (
      connection: Connection,
      input?: {
        readonly workspaceID?: string;
        readonly offset?: number;
        readonly limit?: number;
        readonly expectedCursor?: string;
      },
    ) => Effect.Effect<Contracts.IntegrationSnapshot, BridgeError>;
    readonly events: (
      connection: Connection,
      input: {
        readonly after: string;
        readonly limit?: number;
        readonly waitMs?: number;
      },
    ) => Effect.Effect<Contracts.IntegrationEvents, BridgeError>;
  }
>()("t3/deckhand/CinderdeckClient") {}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isBridgeError = Schema.is(BridgeError);
const MAX_FRAME = 4 * 1024 * 1024;
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const checkSocket = (socketPath: string) =>
    Effect.gen(function* () {
      if (!socketPath.startsWith("/"))
        return yield* new BridgeError({ reason: "unauthorized_socket" });
      const info = yield* fs
        .stat(socketPath)
        .pipe(Effect.mapError((cause) => new BridgeError({ reason: "unavailable", cause })));
      if (
        info.type !== "Socket" ||
        Option.getOrNull(info.uid) !== NodeOS.userInfo().uid ||
        (info.mode & 0o077) !== 0
      ) {
        return yield* new BridgeError({ reason: "unauthorized_socket" });
      }
    });
  const request = (
    socketPath: string,
    method: string,
    params: object,
    timeoutMs = 5000,
    clientID?: string,
  ) =>
    checkSocket(socketPath).pipe(
      Effect.andThen(
        encodeJson({
          id: 1,
          method,
          params,
          client: { name: "Deckhand", ...(clientID ? { session: clientID } : {}) },
        }).pipe(
          Effect.map((frame) => frame + "\n"),
          Effect.mapError((cause) => new BridgeError({ reason: "invalid_request", cause })),
        ),
      ),
      Effect.flatMap((frame) =>
        Buffer.byteLength(frame) <= MAX_FRAME
          ? Effect.succeed(frame)
          : Effect.fail(new BridgeError({ reason: "invalid_request" })),
      ),
      Effect.flatMap((frame) =>
        Effect.tryPromise({
          try: (signal) =>
            new Promise<unknown>((resolve, reject) => {
              const socket = NodeNet.createConnection(socketPath);
              let size = 0;
              let finished = false;
              const chunks: Buffer[] = [];
              const done = (error?: BridgeError, result?: unknown) => {
                if (finished) return;
                finished = true;
                signal.removeEventListener("abort", abort);
                socket.destroy();
                if (error) reject(error);
                else resolve(result);
              };
              const abort = () => done(new BridgeError({ reason: "unavailable" }));
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) return abort();
              socket.on("error", (cause) =>
                done(new BridgeError({ reason: "unavailable", cause })),
              );
              socket.on("end", () => {
                if (!finished) done(new BridgeError({ reason: "invalid_response" }));
              });
              socket.on("connect", () => socket.write(frame));
              socket.on("data", (chunk) => {
                size += chunk.length;
                if (size > MAX_FRAME) return done(new BridgeError({ reason: "invalid_response" }));
                const end = chunk.indexOf(10);
                chunks.push(end >= 0 ? chunk.subarray(0, end) : chunk);
                if (end < 0) return;
                try {
                  const reply = JSON.parse(
                    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
                  ) as {
                    id?: unknown;
                    result?: unknown;
                    error?: { code?: unknown };
                  };
                  if (
                    reply === null ||
                    typeof reply !== "object" ||
                    reply.id !== 1 ||
                    (reply.result !== undefined && reply.error !== undefined)
                  )
                    return done(new BridgeError({ reason: "invalid_response" }));
                  if (reply.error !== undefined) {
                    if (
                      reply.error === null ||
                      typeof reply.error !== "object" ||
                      typeof reply.error.code !== "string" ||
                      reply.error.code.length > 160
                    )
                      return done(new BridgeError({ reason: "invalid_response" }));
                    return done(
                      new BridgeError({
                        reason: "peer_rejected",
                        code: typeof reply.error.code === "string" ? reply.error.code : "unknown",
                      }),
                    );
                  }
                  if (reply.result === undefined)
                    return done(new BridgeError({ reason: "invalid_response" }));
                  done(undefined, reply.result);
                } catch (cause) {
                  done(new BridgeError({ reason: "invalid_response", cause }));
                }
              });
            }),
          catch: (cause) =>
            isBridgeError(cause) ? cause : new BridgeError({ reason: "unavailable", cause }),
        }),
      ),
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(new BridgeError({ reason: "timeout" })),
      }),
    );
  const validInteger = (value: number | undefined, min: number, max: number) =>
    value === undefined || (Number.isSafeInteger(value) && value >= min && value <= max);
  const boundedString = (value: string | undefined, maximum: number) =>
    value === undefined || (value.trim().length > 0 && Buffer.byteLength(value) <= maximum);
  const requiredCapability = (
    connection: Connection,
    capability: string,
  ): Effect.Effect<void, BridgeError> =>
    connection.hello.capabilities.includes(capability)
      ? Effect.void
      : Effect.fail(new BridgeError({ reason: "unsupported_capability", code: capability }));
  const connect = (socketPath: string, expected: ExpectedIdentity) =>
    request(
      socketPath,
      "integration.hello",
      {
        protocolVersions: [1],
        expectedChannel: expected.channel,
        ...(expected.installationID ? { expectedInstallationID: expected.installationID } : {}),
        ...(expected.executionHostID ? { expectedExecutionHostID: expected.executionHostID } : {}),
      },
      5000,
      expected.clientID,
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Contracts.IntegrationHello)),
      Effect.flatMap((hello) =>
        hello.channel !== expected.channel ||
        (expected.installationID && hello.installationID !== expected.installationID) ||
        (expected.executionHostID && hello.executionHostID !== expected.executionHostID)
          ? Effect.fail(new BridgeError({ reason: "invalid_response" }))
          : Effect.succeed({
              socketPath,
              hello,
              ...(expected.clientID ? { clientID: expected.clientID } : {}),
            }),
      ),
      Effect.mapError((cause) =>
        isBridgeError(cause) ? cause : new BridgeError({ reason: "invalid_response", cause }),
      ),
    );
  const snapshot: CinderdeckClient["Service"]["snapshot"] = (connection, input = {}) =>
    requiredCapability(connection, "projection.snapshot").pipe(
      Effect.andThen(() =>
        validInteger(input.offset, 0, Number.MAX_SAFE_INTEGER) &&
        validInteger(input.limit, 1, Math.min(500, connection.hello.maximumPageSize)) &&
        boundedString(input.workspaceID, 160) &&
        boundedString(input.expectedCursor, 512)
          ? request(connection.socketPath, "integration.snapshot", input, 5000, connection.clientID)
          : Effect.fail(new BridgeError({ reason: "invalid_request" })),
      ),
      Effect.flatMap(Schema.decodeUnknownEffect(Contracts.IntegrationSnapshot)),
      Effect.flatMap((result) =>
        result.installationID !== connection.hello.installationID ||
        result.runtimeEpoch !== connection.hello.runtimeEpoch
          ? Effect.fail(new BridgeError({ reason: "stale_binding" }))
          : Effect.succeed(result),
      ),
      Effect.mapError((cause) =>
        isBridgeError(cause) ? cause : new BridgeError({ reason: "invalid_response", cause }),
      ),
    );
  const events: CinderdeckClient["Service"]["events"] = (connection, input) =>
    requiredCapability(connection, "projection.events").pipe(
      Effect.andThen(() =>
        validInteger(input.limit, 1, Math.min(500, connection.hello.maximumPageSize)) &&
        validInteger(input.waitMs, 0, Math.min(25000, connection.hello.maximumWaitMs)) &&
        boundedString(input.after, 512)
          ? request(
              connection.socketPath,
              "integration.events",
              input,
              (input.waitMs ?? 0) + 5000,
              connection.clientID,
            )
          : Effect.fail(new BridgeError({ reason: "invalid_request" })),
      ),
      Effect.flatMap(Schema.decodeUnknownEffect(Contracts.IntegrationEvents)),
      Effect.flatMap((result) =>
        result.installationID !== connection.hello.installationID ||
        result.runtimeEpoch !== connection.hello.runtimeEpoch
          ? Effect.fail(new BridgeError({ reason: "stale_binding" }))
          : Effect.succeed(result),
      ),
      Effect.mapError((cause) =>
        isBridgeError(cause) ? cause : new BridgeError({ reason: "invalid_response", cause }),
      ),
    );
  const decodeOperationInput = Schema.decodeUnknownEffect(Contracts.IntegrationOperationInput);
  const decodeReceipt = Schema.decodeUnknownEffect(Contracts.IntegrationOperationReceipt);
  const submit: CinderdeckClient["Service"]["submit"] = (connection, input) =>
    decodeOperationInput(input).pipe(
      Effect.flatMap((validated) =>
        requiredCapability(
          connection,
          validated.method === "lane.create" ? "operations.lane.create" : "operations.services",
        ).pipe(
          Effect.andThen(
            encodeJson(validated.arguments).pipe(
              Effect.mapError((cause) => new BridgeError({ reason: "invalid_request", cause })),
            ),
          ),
          Effect.flatMap((argumentsJson) =>
            boundedString(connection.clientID, 60) &&
            connection.clientID !== undefined &&
            validated.installationID === connection.hello.installationID &&
            validated.arguments.workspace === validated.workspaceID &&
            Buffer.byteLength(argumentsJson) <= 32768
              ? request(
                  connection.socketPath,
                  "integration.operation.submit",
                  validated,
                  5000,
                  connection.clientID,
                )
              : Effect.fail(new BridgeError({ reason: "invalid_request" })),
          ),
        ),
      ),
      Effect.flatMap(decodeReceipt),
      Effect.flatMap((receipt) =>
        receipt.operationKey === input.operationKey &&
        receipt.workspaceID === input.workspaceID &&
        receipt.generation === input.generation &&
        receipt.method === input.method
          ? Effect.succeed(receipt)
          : Effect.fail(new BridgeError({ reason: "invalid_response" })),
      ),
      Effect.mapError((cause) =>
        isBridgeError(cause) ? cause : new BridgeError({ reason: "invalid_response", cause }),
      ),
    );
  const operation: CinderdeckClient["Service"]["operation"] = (connection, operationKey) =>
    requiredCapability(connection, "operations.receipts").pipe(
      Effect.andThen(() =>
        boundedString(operationKey, 160) && connection.clientID !== undefined
          ? request(
              connection.socketPath,
              "integration.operation.get",
              { operationKey, installationID: connection.hello.installationID },
              5000,
              connection.clientID,
            )
          : Effect.fail(new BridgeError({ reason: "invalid_request" })),
      ),
      Effect.flatMap(decodeReceipt),
      Effect.flatMap((receipt) =>
        receipt.operationKey === operationKey
          ? Effect.succeed(receipt)
          : Effect.fail(new BridgeError({ reason: "invalid_response" })),
      ),
      Effect.mapError((cause) =>
        isBridgeError(cause) ? cause : new BridgeError({ reason: "invalid_response", cause }),
      ),
    );
  return CinderdeckClient.of({ connect, snapshot, events, submit, operation });
});
export const layer = Layer.effect(CinderdeckClient, make);
