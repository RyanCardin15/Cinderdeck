import {
  isProviderNativeSubagentThread,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@cinderdeck/contracts";
import * as Contracts from "@cinderdeck/contracts/deckhand";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "./McpInvocationContext.ts";

const decodeSession = Schema.decodeUnknownEffect(Schema.fromJsonString(Contracts.SessionBinding));
const denied = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message:
      "This managed observer session can use read-only tools. Start a writer session to change files, Git, services, runs, or saved state.",
  });
const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message:
      "The calling session's managed access could not be verified. No mutation was performed.",
  });

export class ManagedMcpToolPolicy extends Context.Service<
  ManagedMcpToolPolicy,
  {
    readonly authorize: (input: {
      readonly name: string;
      readonly readonly: boolean;
      readonly payload: unknown;
    }) => Effect.Effect<void, OrchestratorMcpFailure, Invocation.McpInvocationContext>;
  }
>()("@cinderdeck/server/mcp/ManagedMcpToolPolicy") {}

const make = Effect.gen(function* () {
  // Registration and observation do not need a store. Any mutation without
  // the application's authoritative store is refused before the handler runs.
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const threads = yield* ThreadManagement.ThreadManagementService;
  const binding = (threadId: ThreadId) =>
    Effect.gen(function* () {
      if (Option.isNone(sql)) return yield* unavailable();
      const rows = yield* sql.value<{
        record_json: string;
      }>`SELECT record_json FROM deckhand_sessions WHERE thread_id=${threadId}`;
      if (!rows[0]) return null;
      const saved = yield* decodeSession(rows[0].record_json);
      if (saved.threadId !== threadId) return yield* unavailable();
      return saved;
    });
  const isObserver = (requestedThreadId: ThreadId) =>
    Effect.gen(function* () {
      const visited = new Set<ThreadId>([requestedThreadId]);
      let child = yield* threads.getThreadShell(requestedThreadId);
      for (let depth = 0; depth < 16; depth += 1) {
        if (!child || child.deletedAt !== null) return yield* unavailable();
        const saved = yield* binding(child.id);
        if (saved?.desiredAccess === "read_only" || saved?.role === "observer") return true;
        if (!isProviderNativeSubagentThread(child)) return false;
        // Only provider-owned helper lineage inherits access. User forks and MCP
        // delegated sessions keep their own persisted binding and admission rules.
        const parentId = child.lineage.parentThreadId;
        if (!parentId || visited.has(parentId)) return yield* unavailable();
        visited.add(parentId);
        const parent = yield* threads.getThreadShell(parentId);
        if (!parent || parent.deletedAt !== null || parent.projectId !== child.projectId)
          return yield* unavailable();
        child = parent;
      }
      return yield* unavailable();
    });
  return ManagedMcpToolPolicy.of({
    authorize: (input) =>
      Effect.gen(function* () {
        // Saving a snapshot is a server filesystem write despite the tool's
        // read-only annotation. Unsaved page observations remain available.
        const savesSnapshot =
          input.name === "preview_snapshot" &&
          typeof input.payload === "object" &&
          input.payload !== null &&
          "save" in input.payload &&
          input.payload.save === true;
        if (input.readonly && !savesSnapshot) return;
        const scope = yield* Invocation.McpInvocationContext;
        const observer = yield* isObserver(scope.threadId).pipe(Effect.mapError(unavailable));
        if (observer) return yield* denied();
      }),
  });
});

export const layer = Layer.effect(ManagedMcpToolPolicy, make);
