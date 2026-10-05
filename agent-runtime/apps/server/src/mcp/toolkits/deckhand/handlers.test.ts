import * as Verification from "../../../deckhand/Verification.ts";
import type {
  VerificationOverview,
  Evidence,
} from "@cinderdeck/contracts/deckhand/verificationRpc";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  ProviderInstanceId,
  OrchestratorMcpFailure,
} from "@cinderdeck/contracts";
import {
  ContextPullRequestsPage,
  type ContextPullRequestsInput,
  type ThreadContextView,
} from "@cinderdeck/contracts/deckhand/rpc";
import * as ManagedSessions from "../../../deckhand/ManagedSessions.ts";
import * as Hub from "../../../deckhand/IntegrationHub.ts";
import * as Stream from "effect/Stream";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { handlers } from "./handlers.ts";
import * as Access from "../../DeckhandMcpAccess.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Runs from "../../../deckhand/Runs.ts";
import * as Attempts from "../../../deckhand/VerificationAttempts.ts";
import * as U from "@cinderdeck/contracts/deckhand/runsRpc";
import * as V from "@cinderdeck/contracts/deckhand/verificationAttemptsRpc";
const context = { installationID: "native", workspaceID: "lane", generation: 7 };
const view = {
  feature: { id: "feature" },
  checkout: { id: "checkout" },
} as unknown as ThreadContextView;
const invocation: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  providerSessionId: "session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const failure = new OrchestratorMcpFailure({
  code: "invalid_request",
  message: "The selected build source changed.",
});
const reference = Schema.decodeUnknownSync(V.AttemptPreviewInput.fields.reference)({
  projectId: "project",
  repository: "cardin/app",
  number: 7,
});
describe("Bounded Cinderdeck agent integration tools", () => {
  it.effect(
    "run detail derives native authority from trusted access and keeps actual step pagination",
    () => {
      let observed: U.RunGetInput | null = null;
      const input = {
        runID: "run",
        stepOffset: 16,
        stepLimit: 4,
        installationID: "attacker",
        workspaceID: "other",
        generation: 99,
      };
      return Effect.gen(function* () {
        const result = yield* handlers.deckhand_run_detail(input).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.deepEqual(observed, { ...context, runID: "run", stepOffset: 16, stepLimit: 4 });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Access.DeckhandMcpAccess)({
              resolve: (mutation) => {
                assert.isNotTrue(mutation);
                return Effect.succeed({ actor: "mcp:session", input: context, view });
              },
            }),
            Layer.mock(Runs.Runs)({
              get: (actor, input) => {
                assert.equal(actor, "mcp:session");
                observed = input;
                return Effect.fail(new U.RunsError({ reason: "missing" }));
              },
            }),
            Layer.succeed(Invocation.McpInvocationContext, invocation),
          ),
        ),
      );
    },
  );
  it.effect(
    "exact compact failure reads cannot select another workspace or invent resolution",
    () => {
      let observed: U.RunFailuresInput | null = null;
      const input = { runIDs: ["old-run"], workspaceID: "other" };
      return Effect.gen(function* () {
        const result = yield* handlers.deckhand_run_failures(input);
        assert.deepEqual(observed, { ...context, runIDs: ["old-run"] });
        assert.deepEqual(result.resolutions, []);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Access.DeckhandMcpAccess)({
              resolve: () => Effect.succeed({ actor: "mcp:session", input: context, view }),
            }),
            Layer.mock(Runs.Runs)({
              failures: (_actor, input) => {
                observed = input;
                return Effect.succeed({
                  revision: "r",
                  storageError: null,
                  retainedRunCount: 0,
                  runsTruncated: false,
                  runs: [],
                  resolutions: [],
                });
              },
            }),
            Layer.succeed(Invocation.McpInvocationContext, invocation),
          ),
        ),
      );
    },
  );
  it.effect(
    "verification preview overwrites caller targets and advances require mutation authority plus immutable bound scope",
    () => {
      const calls: Array<unknown> = [];
      const input = { reference, serviceID: "web", featureID: "other", checkoutID: "other" };
      return Effect.gen(function* () {
        assert.equal(
          (yield* handlers.deckhand_verification_attempt_preview(input).pipe(Effect.result))._tag,
          "Failure",
        );
        const refused = yield* handlers
          .deckhand_verification_attempt_advance({ operationKey: "attempt", action: "checks" })
          .pipe(Effect.result);
        assert.equal(refused._tag, "Failure");
        assert.deepEqual(calls, [
          false,
          {
            actor: "mcp:session",
            input: { reference, serviceID: "web", featureID: "feature", checkoutID: "checkout" },
            bound: { featureID: "feature", checkoutID: "checkout", context },
          },
          true,
          {
            actor: "mcp:session",
            input: { operationKey: "attempt", action: "checks" },
            bound: { featureID: "feature", checkoutID: "checkout", context },
          },
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Access.DeckhandMcpAccess)({
              resolve: (mutation) => {
                calls.push(mutation ?? false);
                return Effect.succeed({ actor: "mcp:session", input: context, view });
              },
            }),
            Layer.mock(Attempts.VerificationAttempts)({
              preview: (actor, input, bound) => {
                calls.push({ actor, input, bound });
                return Effect.fail(new V.AttemptError({ reason: "source_changed" }));
              },
              advance: (actor, input, bound) => {
                calls.push({ actor, input, bound });
                return Effect.fail(new V.AttemptError({ reason: "source_changed" }));
              },
            }),
            Layer.succeed(Invocation.McpInvocationContext, invocation),
          ),
        ),
      );
    },
  );
  it.effect("access refusal stops verification before domain reads or effects", () => {
    let called = false;
    return Effect.gen(function* () {
      const result = yield* handlers
        .deckhand_verification_attempt_get({ operationKey: "attempt" })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.isFalse(called);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Access.DeckhandMcpAccess)({ resolve: () => Effect.fail(failure) }),
          Layer.mock(Attempts.VerificationAttempts)({
            get: () => {
              called = true;
              return Effect.fail(new V.AttemptError({ reason: "missing" }));
            },
          }),
          Layer.succeed(Invocation.McpInvocationContext, invocation),
        ),
      ),
    );
  });
});

describe("Scoped before/after agent comparisons", () => {
  const scenario = (id: string, featureID: string) => ({
    id,
    featureID,
    title: "Retry",
    baselineArtifactID: "before",
    followupArtifactID: "after",
    baselineManifestHash: "before-hash",
    followupManifestHash: "after-hash",
    createdAt: "2026-10-04T00:00:00Z",
  });
  const overview: VerificationOverview = {
    head: "head",
    repositoryKeys: [],
    observedAt: "2026-10-04T00:00:00Z",
    contexts: [],
    sessions: [],
    evidence: [
      { artifactID: "before", featureID: "feature" },
      { artifactID: "after", featureID: "feature" },
      { artifactID: "other", featureID: "other-feature" },
    ] as unknown as ReadonlyArray<Evidence>,
    scenarios: [scenario("ours", "feature"), scenario("theirs", "other-feature")],
  };
  it.effect("reads only the calling feature's comparison associations", () =>
    Effect.gen(function* () {
      const result = yield* handlers.deckhand_verification_scenarios({ reference });
      assert.deepEqual(
        result.map((item) => item.id),
        ["ours"],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Access.DeckhandMcpAccess)({
            resolve: () => Effect.succeed({ actor: "mcp:session", input: context, view }),
          }),
          Layer.mock(Verification.Verification)({ list: () => Effect.succeed(overview) }),
          Layer.succeed(Invocation.McpInvocationContext, invocation),
        ),
      ),
    ),
  );
  it.effect("refuses another feature's artifacts or association before mutation", () => {
    let mutations = 0;
    return Effect.gen(function* () {
      const input = {
        reference,
        scenarioID: "new",
        title: "Retry",
        baselineArtifactID: "before",
        followupArtifactID: "other",
      };
      assert.equal(
        (yield* handlers.deckhand_verification_scenario_save(input).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(
        (yield* handlers
          .deckhand_verification_scenario_remove({ reference, scenarioID: "theirs" })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(mutations, 0);
      const saved = yield* handlers.deckhand_verification_scenario_save({
        ...input,
        followupArtifactID: "after",
      });
      assert.equal(mutations, 1);
      assert.deepEqual(
        saved.map((item) => item.id),
        ["ours"],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Access.DeckhandMcpAccess)({
            resolve: (mutation) => {
              assert.equal(mutation, true);
              return Effect.succeed({ actor: "mcp:session", input: context, view });
            },
          }),
          Layer.mock(Verification.Verification)({
            list: () => Effect.succeed(overview),
            scenarioSave: () => {
              mutations++;
              return Effect.succeed(overview);
            },
            scenarioRemove: () => {
              mutations++;
              return Effect.succeed(overview);
            },
          }),
          Layer.succeed(Invocation.McpInvocationContext, invocation),
        ),
      ),
    );
  });
});

describe("Scoped PR agent page", () => {
  const decodePage = Schema.decodeSync(ContextPullRequestsPage);
  const page = decodePage({
    ...context,
    offset: 10000,
    total: 10001,
    nextOffset: null,
    items: [
      {
        projectId: "original-project",
        threadId: "historical-thread",
        link: {
          host: "github.com",
          repository: "cardin/app",
          number: 17,
          url: "https://github.com/cardin/app/pull/17",
          source: "manual",
          linkedAt: "2026-10-04T00:00:00Z",
          snapshot: null,
          stack: null,
        },
      },
    ],
  });
  it.effect(
    "derives current lane scope, preserves actual metadata and closes after the first bounded page",
    () => {
      let observed: ContextPullRequestsInput | null = null;
      let extraReads = 0;
      let closed = 0;
      const input = {
        offset: 10000,
        limit: 50,
        installationID: "attacker",
        workspaceID: "other",
        generation: 99,
        projectId: "other-project",
      };
      return Effect.gen(function* () {
        const result = yield* handlers.deckhand_context_pull_requests(input);
        assert.deepEqual(observed, { ...context, offset: 10000, limit: 50 });
        assert.deepEqual(result, page);
        assert.equal(extraReads, 0);
        assert.equal(closed, 1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Access.DeckhandMcpAccess)({
              resolve: (mutation) => {
                assert.isNotTrue(mutation);
                return Effect.succeed({ actor: "mcp:session", input: context, view });
              },
            }),
            Layer.mock(ManagedSessions.ManagedSessions)({
              subscribePullRequests: (input) => {
                observed = input;
                return Stream.concat(
                  Stream.succeed(page),
                  Stream.fromEffect(
                    Effect.sync(() => {
                      extraReads++;
                      return page;
                    }),
                  ),
                ).pipe(
                  Stream.ensuring(
                    Effect.sync(() => {
                      closed++;
                    }),
                  ),
                );
              },
            }),
            Layer.mock(Hub.IntegrationHub)({}),
            Layer.succeed(Invocation.McpInvocationContext, invocation),
          ),
        ),
      );
    },
  );
  it.effect(
    "uses bounded defaults and keeps an authoritative empty page distinct from missing context",
    () => {
      let observed: ContextPullRequestsInput | null = null;
      const empty = { ...page, offset: 0, items: [], total: 0 };
      return Effect.gen(function* () {
        const result = yield* handlers.deckhand_context_pull_requests({});
        assert.deepEqual(observed, { ...context, offset: 0, limit: 20 });
        assert.deepEqual(result, empty);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Access.DeckhandMcpAccess)({
              resolve: () => Effect.succeed({ actor: "mcp:session", input: context, view }),
            }),
            Layer.mock(ManagedSessions.ManagedSessions)({
              subscribePullRequests: (input) => {
                observed = input;
                return Stream.succeed(empty);
              },
            }),
            Layer.mock(Hub.IntegrationHub)({}),
            Layer.succeed(Invocation.McpInvocationContext, invocation),
          ),
        ),
      );
    },
  );
  it.effect("refuses invalid page bounds before access or native/domain reads", () => {
    let accessReads = 0;
    let pageReads = 0;
    return Effect.gen(function* () {
      for (const input of [
        { offset: -1 },
        { offset: 10001 },
        { offset: 0.5 },
        { limit: 0 },
        { limit: 51 },
        { limit: 1.5 },
      ]) {
        assert.equal(
          (yield* handlers.deckhand_context_pull_requests(input).pipe(Effect.result))._tag,
          "Failure",
        );
      }
      assert.equal(accessReads, 0);
      assert.equal(pageReads, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Access.DeckhandMcpAccess)({
            resolve: () => {
              accessReads++;
              return Effect.succeed({ actor: "mcp:session", input: context, view });
            },
          }),
          Layer.mock(ManagedSessions.ManagedSessions)({
            subscribePullRequests: () => {
              pageReads++;
              return Stream.succeed(page);
            },
          }),
          Layer.mock(Hub.IntegrationHub)({}),
          Layer.succeed(Invocation.McpInvocationContext, invocation),
        ),
      ),
    );
  });
  it.effect("cannot replace an unavailable calling context with a supplied lane", () => {
    let pageReads = 0;
    const input = { offset: 0, workspaceID: "other", installationID: "attacker", generation: 99 };
    return Effect.gen(function* () {
      const result = yield* handlers.deckhand_context_pull_requests(input).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(pageReads, 0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Access.DeckhandMcpAccess)({ resolve: () => Effect.fail(failure) }),
          Layer.mock(ManagedSessions.ManagedSessions)({
            subscribePullRequests: () => {
              pageReads++;
              return Stream.succeed(page);
            },
          }),
          Layer.mock(Hub.IntegrationHub)({}),
          Layer.succeed(Invocation.McpInvocationContext, invocation),
        ),
      ),
    );
  });
  it.effect(
    "keeps native context refusal and missing stream state as failures instead of empty success",
    () => {
      let reads = 0;
      return Effect.gen(function* () {
        assert.equal(
          (yield* handlers.deckhand_context_pull_requests({}).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* handlers.deckhand_context_pull_requests({}).pipe(Effect.result))._tag,
          "Failure",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Access.DeckhandMcpAccess)({
              resolve: () => Effect.succeed({ actor: "mcp:session", input: context, view }),
            }),
            Layer.mock(ManagedSessions.ManagedSessions)({
              subscribePullRequests: () =>
                ++reads === 1
                  ? Stream.fail(
                      new ManagedSessions.ManagedSessionsError({ reason: "source_unavailable" }),
                    )
                  : Stream.empty,
            }),
            Layer.mock(Hub.IntegrationHub)({}),
            Layer.succeed(Invocation.McpInvocationContext, invocation),
          ),
        ),
      );
    },
  );
});
