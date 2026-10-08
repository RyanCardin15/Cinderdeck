import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { InteractionUpdate } from "@cursor/sdk";
import {
  CursorSettings,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@cinderdeck/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import {
  cursorMcpServers,
  cursorRuntimeAgentPolicy,
  cursorSdkModelSelection,
  makeCursorAgentOptions,
  makeCursorAdapterV2,
  nestedToolCallFromEnvelope,
} from "./CursorAdapterV2.ts";
import { isCursorCancellationError, loggedCursorAgentOptions } from "./CursorAgentSdk.ts";

const decodeCursorSettings = Schema.decodeEffect(CursorSettings);

const runCursorTurnWithUpdates = (input: {
  readonly prefix: string;
  readonly updates: ReadonlyArray<InteractionUpdate>;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: `${input.prefix}-` });
    const instanceId = ProviderInstanceId.make("cursor");
    const threadId = ThreadId.make(`${input.prefix}-thread`);
    const modelSelection = { instanceId, model: "composer-2.5" };
    const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: workspace,
    });
    const adapter = makeCursorAdapterV2({
      instanceId,
      settings: yield* decodeCursorSettings({}),
      environment: { HOME: workspace },
      fileSystem,
      path,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ServerConfig.ServerConfig.pipe(
        Effect.provide(ServerConfig.layerTest(workspace, { prefix: `${input.prefix}-config-` })),
      ),
      runner: {
        assertComplete: Effect.void,
        open: () =>
          Effect.succeed({
            agentId: `native-${input.prefix}`,
            listMessages: Effect.succeed([]),
            close: Effect.void,
            send: (sendInput) =>
              Effect.gen(function* () {
                for (const update of input.updates) {
                  yield* sendInput.onDelta!(update).pipe(Effect.orDie);
                }
                return {
                  agentId: `native-${input.prefix}`,
                  runId: `native-${input.prefix}-run`,
                  wait: Effect.succeed({
                    id: `native-${input.prefix}-run`,
                    requestId: "native-request",
                    status: "finished" as const,
                    model: { id: "composer-2.5" },
                    durationMs: 1,
                  }),
                  cancel: Effect.void,
                };
              }),
          }),
      },
    });
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`${input.prefix}-session`),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const now = yield* DateTime.now;
    yield* runtime.startTurn({
      threadId,
      providerThread,
      modelSelection,
      runtimePolicy,
      runId: RunId.make(`${input.prefix}-run`),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make(`${input.prefix}-attempt`),
      rootNodeId: NodeId.make(`${input.prefix}-root`),
      appThread: {
        id: threadId,
        projectId: ProjectId.make(`${input.prefix}-project`),
        createdBy: "user",
        creationSource: "web",
        title: "Cursor subagents",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      message: {
        messageId: MessageId.make(`${input.prefix}-message`),
        createdBy: "user",
        creationSource: "web",
        text: "Delegate the work.",
        attachments: [],
      },
    });
    const events = yield* runtime.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
    );
    return Array.from(events);
  });

type CollectedEvent = Effect.Success<ReturnType<typeof runCursorTurnWithUpdates>>[number];

const turnItemEvents = (events: ReadonlyArray<CollectedEvent>, threadId: string) =>
  events.flatMap((event, index) =>
    event.type === "turn_item.updated" && event.turnItem.threadId === threadId
      ? [{ index, turnItem: event.turnItem }]
      : [],
  );

const latestTurnItems = (events: ReadonlyArray<CollectedEvent>, threadId: string) => {
  const latest = new Map<
    string,
    Extract<CollectedEvent, { type: "turn_item.updated" }>["turnItem"]
  >();
  for (const { turnItem } of turnItemEvents(events, threadId)) {
    latest.set(turnItem.id, turnItem);
  }
  return Array.from(latest.values()).toSorted((left, right) => left.ordinal - right.ordinal);
};

const backgroundTaskUpdates: ReadonlyArray<InteractionUpdate> = [
  {
    type: "tool-call-started",
    modelCallId: "model-call",
    callId: "bg-task",
    toolCall: {
      type: "task",
      args: {
        description: "Audit",
        prompt: "Audit the repository.",
        subagentType: { kind: "unspecified" },
        agentId: "bg-agent",
        mode: "unspecified",
      },
    },
  },
  {
    type: "tool-call-completed",
    modelCallId: "model-call",
    callId: "bg-task",
    toolCall: {
      type: "task",
      args: {
        description: "Audit",
        prompt: "Audit the repository.",
        subagentType: { kind: "unspecified" },
        agentId: "bg-agent",
        mode: "unspecified",
      },
      result: {
        status: "success",
        value: {
          agentId: "bg-agent",
          isBackground: true,
          backgroundReason: "agentRequest",
          conversationSteps: [],
          resultSuffix: "Agent bg-agent is running in the background.",
        },
      },
    },
  },
  {
    type: "tool-call-delta",
    modelCallId: "model-call",
    callId: "bg-task",
    taskUpdate: {
      type: "tool-call-started",
      modelCallId: "child-model-call",
      callId: "bg-read",
      toolCall: { type: "read", args: { path: "/repo/README.md" } },
    },
  },
];

describe("CursorAdapterV2", () => {
  it.effect.each([
    { status: "finished", model: undefined },
    { status: "cancelled", model: "claude-opus-4-6" },
    { status: "error", model: "custom-fable" },
  ] as const)(
    "settles missing task completions when the Cursor run is $status",
    ({ status, model }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspace = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cursor-v2-lifecycle-",
        });
        const instanceId = ProviderInstanceId.make("cursor");
        const threadId = ThreadId.make("cursor-lifecycle-thread");
        const modelSelection = { instanceId, model: "composer-2.5" };
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: workspace,
        });
        const adapter = makeCursorAdapterV2({
          instanceId,
          settings: yield* decodeCursorSettings({}),
          environment: { HOME: workspace },
          fileSystem,
          path,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          serverConfig: yield* ServerConfig.ServerConfig.pipe(
            Effect.provide(
              ServerConfig.layerTest(workspace, { prefix: "cursor-v2-lifecycle-config-" }),
            ),
          ),
          runner: {
            assertComplete: Effect.void,
            open: () =>
              Effect.succeed({
                agentId: "native-cursor-lifecycle",
                listMessages: Effect.succeed([]),
                close: Effect.void,
                send: (input) =>
                  Effect.gen(function* () {
                    // Recorded Cursor task calls (see fixtures/subagent) stream a
                    // partial-tool-call before tool-call-started with the same args.
                    // The run then ends without tool-call-completed, which a live
                    // run cannot produce on demand.
                    const taskToolCall = {
                      type: "task" as const,
                      args: {
                        description: "Review",
                        prompt: "Review the code.",
                        subagentType: { kind: "unspecified" },
                        ...(model === undefined ? {} : { model }),
                        agentId: "cursor-task-agent",
                        mode: "unspecified" as const,
                      },
                    };
                    for (const type of ["partial-tool-call", "tool-call-started"] as const) {
                      yield* input.onDelta!({
                        type,
                        modelCallId: "model-call",
                        callId: "task-call",
                        toolCall: taskToolCall,
                      }).pipe(Effect.orDie);
                    }
                    return {
                      agentId: "native-cursor-lifecycle",
                      runId: "native-cursor-run",
                      wait: Effect.succeed({
                        id: "native-cursor-run",
                        requestId: "native-request",
                        status,
                        model: { id: "composer-2.5" },
                        durationMs: 1,
                      }),
                      cancel: Effect.void,
                    };
                  }),
              }),
          },
        });
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("cursor-lifecycle-session"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn({
          threadId,
          providerThread,
          modelSelection,
          runtimePolicy,
          runId: RunId.make("cursor-lifecycle-run"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("cursor-lifecycle-attempt"),
          rootNodeId: NodeId.make("cursor-lifecycle-root"),
          appThread: {
            id: threadId,
            projectId: ProjectId.make("cursor-lifecycle-project"),
            createdBy: "user",
            creationSource: "web",
            title: "Cursor lifecycle",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: providerThread.id,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          message: {
            messageId: MessageId.make("cursor-lifecycle-message"),
            createdBy: "user",
            creationSource: "web",
            text: "Review the code.",
            attachments: [],
          },
        });
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const rows = events.filter((event) => event.type === "subagent.updated");
        assert.equal(rows[0]?.subagent.status, "running");
        assert.equal(rows[0]?.subagent.model, model ?? null);
        assert.equal(
          rows.at(-1)?.subagent.status,
          status === "finished" ? "idle" : status === "cancelled" ? "cancelled" : "failed",
        );
        assert.isNotNull(rows.at(-1)?.subagent.completedAt);
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, IdAllocator.layer))),
  );

  it.effect("fails standalone SDK transport diagnostics and sends compaction as /compress", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-errors-" });
      const sentMessages: Array<string> = [];
      let sendCalls = 0;
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-transport-error-thread");
      const modelSelection = { instanceId, model: "composer-2.5" };
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const adapter = makeCursorAdapterV2({
        instanceId,
        settings: yield* decodeCursorSettings({}),
        environment: { HOME: workspace },
        fileSystem,
        path,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ServerConfig.ServerConfig.pipe(
          Effect.provide(ServerConfig.layerTest(workspace, { prefix: "cursor-v2-error-config-" })),
        ),
        runner: {
          assertComplete: Effect.void,
          open: () =>
            Effect.succeed({
              agentId: "native-cursor-error",
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: (input) =>
                Effect.sync(() => {
                  sendCalls += 1;
                  sentMessages.push(
                    typeof input.message === "string" ? input.message : input.message.text,
                  );
                  const runId = `native-cursor-run-${sendCalls}`;
                  return {
                    agentId: "native-cursor-error",
                    runId,
                    wait: Effect.succeed({
                      id: runId,
                      requestId: `native-request-${sendCalls}`,
                      status: "finished" as const,
                      model: { id: "composer-2.5" },
                      durationMs: 1,
                      ...(sendCalls === 1
                        ? { result: "Error: RetriableError: WritableIterable is closed" }
                        : {}),
                    }),
                    cancel: Effect.void,
                  };
                }),
            }),
        },
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-error-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const appThread = {
        id: threadId,
        projectId: ProjectId.make("cursor-error-project"),
        createdBy: "user" as const,
        creationSource: "web" as const,
        title: "Cursor transport failure",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* runtime.startTurn({
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        runId: RunId.make("cursor-error-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("cursor-error-attempt"),
        rootNodeId: NodeId.make("cursor-error-root"),
        appThread,
        message: {
          messageId: MessageId.make("cursor-error-message"),
          createdBy: "user",
          creationSource: "web",
          text: "continue",
          attachments: [],
        },
      });
      const first = yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.isTrue(Option.isSome(first));
      if (Option.isSome(first)) {
        assert.equal(first.value.status, "failed");
        assert.equal(first.value.failure?.class, "transport_error");
      }

      assert.isDefined(runtime.compactThread);
      yield* runtime.compactThread!({
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        runId: RunId.make("cursor-compact-run"),
        runOrdinal: 2,
        providerTurnOrdinal: 2,
        attemptId: RunAttemptId.make("cursor-compact-attempt"),
        rootNodeId: NodeId.make("cursor-compact-root"),
        appThread,
        message: {
          messageId: MessageId.make("cursor-compact-message"),
          createdBy: "user",
          creationSource: "web",
          text: "ignored by compactThread",
          attachments: [],
        },
      });
      yield* runtime.events.pipe(
        Stream.filter((event) => event.type === "turn.terminal"),
        Stream.runHead,
      );
      assert.equal(sentMessages[1], "/compress");
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, IdAllocator.layer))),
  );

  it.effect("projects Cursor directory trees and lint diagnostics as file search results", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-v2-search-" });
      const instanceId = ProviderInstanceId.make("cursor");
      const threadId = ThreadId.make("cursor-search-thread");
      const modelSelection = { instanceId, model: "composer-2.5" };
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: workspace,
      });
      const emptyLsNode = {
        childrenDirs: [],
        childrenFiles: [],
        childrenWereProcessed: true,
        fullSubtreeExtensionCounts: {},
        numFiles: 0,
      };
      const updates: ReadonlyArray<InteractionUpdate> = [
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "read-file",
          toolCall: {
            type: "read",
            args: { path: "src/env.ts" },
            result: {
              status: "success",
              value: { fileSize: 12, content: "---\nfile body", totalLines: 2 },
            },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "ls-nested",
          toolCall: {
            type: "ls",
            args: { path: workspace },
            result: {
              status: "success",
              value: {
                directoryTreeRoot: {
                  ...emptyLsNode,
                  absPath: workspace,
                  childrenFiles: [{ name: "README.md" }],
                  childrenDirs: [
                    {
                      ...emptyLsNode,
                      absPath: path.join(workspace, "src"),
                      childrenFiles: [{ name: "index.ts" }],
                      childrenDirs: [
                        {
                          ...emptyLsNode,
                          absPath: path.join(workspace, "src", "nested"),
                          childrenFiles: [{ name: "util.ts" }],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "ls-empty",
          toolCall: {
            type: "ls",
            args: { path: path.join(workspace, "empty") },
            result: {
              status: "success",
              value: {
                directoryTreeRoot: { ...emptyLsNode, absPath: path.join(workspace, "empty") },
              },
            },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "ls-failed",
          toolCall: {
            type: "ls",
            args: { path: path.join(workspace, "missing") },
            result: { status: "error", error: "ENOENT" },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "lints",
          toolCall: {
            type: "readLints",
            args: { paths: ["src/a.ts", "src/b.ts"] },
            result: {
              status: "success",
              value: {
                totalFiles: 2,
                totalDiagnostics: 3,
                fileDiagnostics: [
                  {
                    path: "src/a.ts",
                    diagnosticsCount: 2,
                    diagnostics: [
                      {
                        message: "Unused variable",
                        code: "TS6133",
                        source: "ts",
                        severity: "warning",
                        range: { start: { line: 0, character: 4 } },
                      },
                      {
                        message: "Cannot find name",
                        code: "TS2304",
                        source: "ts",
                        severity: "error",
                        range: { start: { line: 11 } },
                      },
                    ],
                  },
                  {
                    path: "src/b.ts",
                    diagnosticsCount: 1,
                    diagnostics: [
                      {
                        message: "File-level diagnostic",
                        code: "TS0",
                        source: "ts",
                        severity: "information",
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "lints-empty",
          toolCall: {
            type: "readLints",
            args: { paths: ["src/clean.ts"] },
            result: {
              status: "success",
              value: {
                totalFiles: 1,
                totalDiagnostics: 0,
                fileDiagnostics: [{ path: "src/clean.ts", diagnosticsCount: 0, diagnostics: [] }],
              },
            },
          },
        },
        {
          type: "tool-call-completed",
          modelCallId: "native-model-call",
          callId: "lints-failed",
          toolCall: {
            type: "readLints",
            args: { paths: ["src/a.ts"] },
            result: { status: "error", error: "lint failed" },
          },
        },
      ];
      const adapter = makeCursorAdapterV2({
        instanceId,
        settings: yield* decodeCursorSettings({}),
        environment: { HOME: workspace },
        fileSystem,
        path,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ServerConfig.ServerConfig.pipe(
          Effect.provide(ServerConfig.layerTest(workspace, { prefix: "cursor-v2-search-config-" })),
        ),
        runner: {
          assertComplete: Effect.void,
          open: () =>
            Effect.succeed({
              agentId: "native-cursor-search",
              listMessages: Effect.succeed([]),
              close: Effect.void,
              send: (input) =>
                Effect.gen(function* () {
                  for (const update of updates) {
                    if (input.onDelta !== undefined) {
                      yield* input.onDelta(update).pipe(Effect.orDie);
                    }
                  }
                  return {
                    agentId: "native-cursor-search",
                    runId: "native-cursor-run",
                    wait: Effect.succeed({
                      id: "native-cursor-run",
                      requestId: "native-request",
                      status: "finished" as const,
                      model: { id: "composer-2.5" },
                      durationMs: 1,
                    }),
                    cancel: Effect.void,
                  };
                }),
            }),
        },
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("cursor-search-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      yield* runtime.startTurn({
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy,
        runId: RunId.make("cursor-search-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("cursor-search-attempt"),
        rootNodeId: NodeId.make("cursor-search-root"),
        appThread: {
          id: threadId,
          projectId: ProjectId.make("cursor-search-project"),
          createdBy: "user",
          creationSource: "web",
          title: "Cursor search results",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        message: {
          messageId: MessageId.make("cursor-search-message"),
          createdBy: "user",
          creationSource: "web",
          text: "inspect the workspace",
          attachments: [],
        },
      });
      const events = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runCollect,
      );
      const fileSearchItems = events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "file_search" &&
        event.turnItem.status !== "running"
          ? [event.turnItem]
          : [],
      );
      const readItems = events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "dynamic_tool" &&
        event.turnItem.toolName === "Read" &&
        event.turnItem.status === "completed"
          ? [event.turnItem]
          : [],
      );
      assert.deepEqual(
        readItems.map((item) => ({ title: item.title, input: item.input })),
        [{ title: "Read src/env.ts", input: { path: "src/env.ts" } }],
      );
      assert.deepEqual(
        fileSearchItems.map((item) => ({
          pattern: item.pattern,
          status: item.status,
          results: item.results,
        })),
        [
          {
            pattern: workspace,
            status: "completed",
            results: [
              { fileName: path.join(workspace, "README.md") },
              { fileName: path.join(workspace, "src", "index.ts") },
              { fileName: path.join(workspace, "src", "nested", "util.ts") },
            ],
          },
          {
            pattern: path.join(workspace, "empty"),
            status: "completed",
            results: undefined,
          },
          {
            pattern: path.join(workspace, "missing"),
            status: "failed",
            results: undefined,
          },
          {
            pattern: "src/a.ts, src/b.ts",
            status: "completed",
            results: [
              { fileName: "src/a.ts", line: 1, column: 5, preview: "Unused variable" },
              { fileName: "src/a.ts", line: 12, preview: "Cannot find name" },
              { fileName: "src/b.ts", preview: "File-level diagnostic" },
            ],
          },
          {
            pattern: "src/clean.ts",
            status: "completed",
            results: undefined,
          },
          {
            pattern: "src/a.ts",
            status: "failed",
            results: undefined,
          },
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, IdAllocator.layer))),
  );

  it("maps Cursor auto and model parameters to SDK selections", () => {
    assert.deepEqual(
      cursorSdkModelSelection({
        instanceId: ProviderInstanceId.make("cursor"),
        model: "auto",
        options: [
          { id: "thinking", value: "high" },
          { id: "contextWindow", value: "1m" },
          { id: "fastMode", value: true },
        ],
      }),
      {
        id: "default",
        params: [
          { id: "thinking", value: "high" },
          { id: "context", value: "1m" },
          { id: "fast", value: "true" },
        ],
      },
    );
  });

  it("maps runtime modes to the SDK sandbox and auto-review controls", () => {
    const base = {
      interactionMode: "default" as const,
      cwd: "/tmp/cursor-adapter",
    };
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "full-access",
      }),
      {
        autoReview: false,
        sandboxEnabled: false,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "auto-accept-edits",
      }),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "approval-required",
      }),
      {
        autoReview: true,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "full-access",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      }),
      {
        autoReview: false,
        sandboxEnabled: true,
      },
    );
    assert.deepEqual(
      cursorRuntimeAgentPolicy({
        ...base,
        runtimeMode: "approval-required",
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      }),
      {
        autoReview: false,
        sandboxEnabled: false,
      },
    );
  });

  it("loads the user's Cursor settings layers in every runtime mode", () => {
    // The SDK loads no rules, skills, hooks, or MCP config from disk unless
    // settingSources names them, so an omitted list silently drops AGENTS.md.
    for (const runtimeMode of ["full-access", "auto-accept-edits", "approval-required"] as const) {
      const options = makeCursorAgentOptions({
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2.5",
        },
        runtimePolicy: { runtimeMode, interactionMode: "default", cwd: "/workspace" },
        threadId: ThreadId.make("thread-cursor-setting-sources"),
      });
      assert.deepEqual(options.local?.settingSources, [
        "project",
        "user",
        "team",
        "mdm",
        "plugins",
      ]);
    }
  });

  it("injects thread-scoped MCP credentials without logging them", () => {
    const threadId = ThreadId.make("thread-cursor-mcp");
    McpProviderSession.setMcpProviderSession({
      environmentId: EnvironmentId.make("environment-cursor-mcp"),
      threadId,
      providerSessionId: "mcp-session-cursor",
      providerInstanceId: ProviderInstanceId.make("cursor"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-cursor-mcp-token",
      browserToolsAvailable: true,
    });

    try {
      assert.deepEqual(cursorMcpServers(threadId), {
        deckhand: {
          type: "http",
          url: "http://127.0.0.1:43123/mcp",
          headers: {
            Authorization: "Bearer secret-cursor-mcp-token",
          },
        },
      });

      const options = makeCursorAgentOptions({
        apiKey: "secret-cursor-api-key",
        modelSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2.5",
        },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace",
        },
        threadId,
      });
      assert.deepEqual(options.mcpServers, cursorMcpServers(threadId));

      const logged = JSON.stringify(loggedCursorAgentOptions(options));
      assert.notInclude(logged, "secret-cursor-api-key");
      assert.notInclude(logged, "secret-cursor-mcp-token");
    } finally {
      McpProviderSession.clearMcpProviderSession(threadId);
    }
  });

  it("recognizes direct and SDK-wrapped abort failures as cancellation", () => {
    assert.isTrue(isCursorCancellationError({ name: "AbortError" }));
    assert.isTrue(
      isCursorCancellationError({
        name: "ConnectError",
        cause: {
          name: "ConnectError",
          cause: { name: "AbortError" },
        },
      }),
    );
    assert.isFalse(isCursorCancellationError(new Error("request failed")));
    assert.isFalse(isCursorCancellationError(null));
  });

  it.effect(
    "projects recorded Cursor subagent activity live and settles it without duplicate child rows",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const transcript = yield* fileSystem.readFileString(
          new URL("../testkit/fixtures/subagent/cursor_transcript.ndjson", import.meta.url)
            .pathname,
        );
        const updates = transcript
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .flatMap((line) => {
            const entry = JSON.parse(line) as {
              readonly type: string;
              readonly frame?: { readonly type: string; readonly update?: InteractionUpdate };
            };
            return entry.type === "emit_inbound" &&
              entry.frame?.type === "interaction.update" &&
              entry.frame.update !== undefined
              ? [entry.frame.update]
              : [];
          });
        const events = yield* runCursorTurnWithUpdates({ prefix: "cursor-live-subagent", updates });

        const subagentRows = events.flatMap((event, index) =>
          event.type === "subagent.updated" ? [{ index, subagent: event.subagent }] : [],
        );
        const subagentIds = Array.from(new Set(subagentRows.map((row) => row.subagent.id)));
        assert.lengthOf(subagentIds, 2);
        for (const subagentId of subagentIds) {
          const rows = subagentRows.filter((row) => row.subagent.id === subagentId);
          const final = rows.at(-1)!.subagent;
          assert.equal(final.status, "completed");
          const childThreadId = final.childThreadId!;
          const completedAt = rows.find((row) => row.subagent.status === "completed")!.index;
          const childEvents = turnItemEvents(events, childThreadId);

          // The child thread shows the subagent's reply and tool call while it runs.
          assert.isTrue(
            childEvents.some(
              ({ index, turnItem }) =>
                index < completedAt && turnItem.type === "assistant_message" && turnItem.streaming,
            ),
          );
          assert.isTrue(
            childEvents.some(
              ({ index, turnItem }) =>
                index < completedAt &&
                turnItem.type === "dynamic_tool" &&
                turnItem.status === "completed",
            ),
          );

          // Every child row keeps one ordinal, so completion updates rows in place.
          const ordinals = new Map<string, Set<number>>();
          for (const { turnItem } of childEvents) {
            ordinals.set(
              turnItem.id,
              (ordinals.get(turnItem.id) ?? new Set()).add(turnItem.ordinal),
            );
          }
          for (const values of ordinals.values()) {
            assert.equal(values.size, 1);
          }

          const childItems = latestTurnItems(events, childThreadId);
          assert.deepEqual(
            childItems.map((item) => item.type),
            ["user_message", "assistant_message", "dynamic_tool", "assistant_message"],
          );
          for (const item of childItems) {
            assert.equal(item.status, "completed");
            if (item.type === "assistant_message") assert.isFalse(item.streaming);
          }
          const finalReply = childItems.at(-1);
          assert.include(
            finalReply?.type === "assistant_message" ? finalReply.text : "",
            "## Summary",
          );
          assert.include(final.result ?? "", "## Summary");
        }
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, IdAllocator.layer))),
  );

  it.effect("keeps a background Cursor task working until the turn ends without its outcome", () =>
    Effect.gen(function* () {
      const events = yield* runCursorTurnWithUpdates({
        prefix: "cursor-background-subagent",
        updates: backgroundTaskUpdates,
      });
      const rows = events.flatMap((event) =>
        event.type === "subagent.updated" ? [event.subagent] : [],
      );
      // The launch acknowledgement is not a result.
      const acknowledged = rows[1]!;
      assert.equal(acknowledged.status, "running");
      assert.isNull(acknowledged.completedAt);
      assert.isNull(acknowledged.result);
      assert.isString(acknowledged.progress);
      assert.isFalse(rows.some((row) => row.status === "completed"));

      // Child activity after the launch still reaches the child thread.
      const childThreadId = acknowledged.childThreadId!;
      assert.isTrue(
        latestTurnItems(events, childThreadId).some((item) => item.type === "dynamic_tool"),
      );

      // Cursor never reported the outcome before the turn ended.
      const final = rows.at(-1)!;
      assert.equal(final.status, "idle");
      assert.isNotNull(final.completedAt);
      assert.isNull(final.result);
      assert.isUndefined(final.progress);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, IdAllocator.layer))),
  );

  it.effect("settles a background Cursor task from the call that awaits its agent", () =>
    Effect.gen(function* () {
      const awaitArgs = {
        description: "",
        prompt: "",
        resume: "bg-agent",
        subagentType: { kind: "unspecified" },
        mode: "unspecified" as const,
      };
      const events = yield* runCursorTurnWithUpdates({
        prefix: "cursor-awaited-subagent",
        updates: [
          ...backgroundTaskUpdates,
          {
            type: "tool-call-started",
            modelCallId: "model-call",
            callId: "await-task",
            toolCall: { type: "task", args: awaitArgs },
          },
          {
            type: "tool-call-completed",
            modelCallId: "model-call",
            callId: "await-task",
            toolCall: {
              type: "task",
              args: awaitArgs,
              result: {
                status: "success",
                value: {
                  agentId: "bg-agent",
                  isBackground: false,
                  backgroundReason: "unspecified",
                  conversationSteps: [
                    { assistantMessage: { text: "The audit found no problems." } },
                  ],
                },
              },
            },
          },
        ],
      });
      const rows = events.flatMap((event) =>
        event.type === "subagent.updated" ? [event.subagent] : [],
      );
      assert.lengthOf(new Set(rows.map((row) => row.id)), 1);
      assert.lengthOf(
        events.filter((event) => event.type === "app_thread.created"),
        1,
      );
      const final = rows.at(-1)!;
      assert.equal(final.status, "completed");
      assert.equal(final.prompt, "Audit the repository.");
      assert.equal(final.result, "The audit found no problems.");
      assert.isUndefined(final.progress);
      const childItems = latestTurnItems(events, final.childThreadId!);
      assert.isTrue(
        childItems.some(
          (item) =>
            item.type === "assistant_message" && item.text === "The audit found no problems.",
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, IdAllocator.layer))),
  );

  it("preserves failed nested read calls when Cursor omits their path", () => {
    assert.deepEqual(
      nestedToolCallFromEnvelope({
        toolCallId: "tool:failed-read",
        readToolCall: {
          args: {},
          result: { error: "File path was not provided." },
        },
      }),
      {
        callId: "tool:failed-read",
        toolCall: {
          type: "read",
          args: { path: "<unknown path>" },
          result: {
            status: "error",
            error: "File path was not provided.",
          },
        },
      },
    );
  });
});
