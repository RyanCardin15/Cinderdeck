import { assert, it } from "@effect/vitest";
import { EventId, ProjectId, ProviderDriverKind, ThreadId } from "@cinderdeck/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import { threadCreated } from "../../integration/TransferBudgetV2Fixture.integration.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as Events from "../persistence/Services/OrchestrationEventStore.ts";
import * as Projects from "./ProjectStore.ts";
import * as Projection from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { initialShellIds, loadDeferredShell, readShellPage } from "./ShellPaging.ts";

const database = Projection.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const management = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* Projection.ProjectionStoreV2;
    return Layer.mock(ThreadManagement.ThreadManagementService)({
      getShellSnapshot: (options) => store.getShellSnapshot(options).pipe(Effect.orDie),
    });
  }),
).pipe(Layer.provideMerge(database));
const testLayer = Layer.mergeAll(
  management,
  Layer.mock(Events.OrchestrationEventStore)({ latestApplicationSequence: Effect.succeed(777) }),
  Layer.mock(Projects.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
);
it.effect(
  "keeps live work and ancestors while paging every deferred thread from its exact project/family",
  () =>
    Effect.gen(function* () {
      const store = yield* Projection.ProjectionStoreV2;
      for (let index = 0; index < 250; index++) {
        const id = ThreadId.make(`thread-${String(index).padStart(3, "0")}`);
        const event = threadCreated(ProviderDriverKind.make("codex"));
        if (event.type !== "thread.created") throw new Error("fixture");
        yield* store.apply({
          ...event,
          id: EventId.make(`created-${index}`),
          threadId: id,
          payload: {
            ...event.payload,
            id,
            projectId: ProjectId.make(index < 240 ? "one" : "two"),
            lineage: {
              rootThreadId: index < 240 ? ThreadId.make("thread-000") : id,
              parentThreadId: index > 0 && index < 240 ? ThreadId.make("thread-000") : null,
              relationshipToParent: index > 0 && index < 240 ? "subagent" : null,
            },
          },
        });
      }
      const thin = yield* loadDeferredShell;
      assert.equal(thin.threads.length, 11);
      assert.equal(thin.deferredThreadRefs.length, 250);
      assert.equal(thin.snapshotSequence, 777);
      const ids: string[] = [];
      let afterId: ThreadId | undefined;
      do {
        const page = yield* readShellPage({
          projectIds: [ProjectId.make("one")],
          ...(afterId ? { afterId } : {}),
        });
        assert.isAtMost(page.threads.length, 100);
        ids.push(...page.threads.map((row) => row.id));
        afterId = page.nextId ?? undefined;
      } while (afterId);
      assert.equal(ids.length, 240);
      assert.equal(new Set(ids).size, 240);
      const family = yield* readShellPage({
        projectIds: [],
        threadIds: [ThreadId.make("thread-100")],
      });
      assert.equal(family.threads.length, 100);
      assert.isNotNull(family.nextId);
      const none = yield* readShellPage({ projectIds: [], threadIds: [ThreadId.make("missing")] });
      assert.deepEqual(none.threads, []);
      assert.isNull(none.nextId);
    }).pipe(Effect.provide(testLayer)),
);

it("retains the newest 25 settled roots, ties, pins, live children and all ancestors", () => {
  const at = DateTime.makeUnsafe("2026-11-01T00:00:00Z");
  const rows = Array.from({ length: 60 }, (_, index) => ({
    id: ThreadId.make(`s-${index}`),
    projectId: ProjectId.make("p"),
    lineage: {
      rootThreadId: ThreadId.make(`s-${index}`),
      parentThreadId: null,
      relationshipToParent: null,
    },
    settledOverride: "settled" as const,
    settledAt: DateTime.add(at, { seconds: index }),
    pinnedAt: null,
    snoozedUntil: null,
    mayBeLive: false,
  }));
  assert.equal(initialShellIds(rows).length, 25);
  const pinned = { ...rows[0]!, pinnedAt: at };
  const liveChild = {
    ...rows[1]!,
    lineage: {
      ...rows[1]!.lineage,
      parentThreadId: pinned.id,
      relationshipToParent: "subagent" as const,
    },
    mayBeLive: true,
  };
  const selected = initialShellIds([pinned, liveChild, ...rows.slice(2)]);
  assert.include(selected, pinned.id);
  assert.include(selected, liveChild.id);
});
