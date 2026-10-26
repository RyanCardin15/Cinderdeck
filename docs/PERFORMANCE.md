# Performance audit: workspace UI and agent controls

Audited September 28, 2026, against baseline `c005979d`. The work targets shared runtime costs that affect the Workspaces UI, terminals, tasks/workflows, Git operations, CLI and MCP clients.

## Changes

| Area | Finding | Change |
| --- | --- | --- |
| Short commands | Checking `waitpid` every 25 ms imposed a latency floor and repeated wakeups on Git and other commands. | Kernel process-exit notifications, one deadline timer, serialized completion and cancellation, and exactly one reap. Child signal masks/dispositions are reset to normal shell behavior. |
| Service log API | A request for 200 lines merged every retained line. Unchanged cursor polls did the same work. | Filter at the source; use a heap to merge only the requested tail. A timestamp high-water mark rejects unchanged polls without scanning or copying buffers. |
| Combined terminals | Merging K service buffers scanned all K heads for every output line, on the main actor. | O(N log K) heap merge; large combined merges run off the main actor. Existing line IDs, per-buffer order and tie order are preserved. |
| Live searches | New output reparsed ANSI and searched all old lines. Run-detail redraws repeated filtering. | Cache match decisions by line ID for the current query; evict entries with their lines. Refilter only when output or the query changes. Plain output bypasses styled ANSI parsing. |
| Task/workflow logs | Reading a short tail visited every earlier step and could churn the 32-step output cache. | Walk backwards through steps until enough lines are available, preserving the displayed step order. |
| Workspace navigation | Sidebar and map renders repeatedly rebuilt workspace/lane membership and rescanned arrays. | One indexed navigation snapshot per definition update; dictionary/set lookups for membership and lane groups. |
| Execution map | Every animation frame reconstructed and stroked static connections as well as moving dots. | Separate the static connection canvas from activity animation; precompute routes and outgoing connection counts. Pause when no visible activity exists or Reduce Motion is enabled. |
| Completed runs | Completed run duration views retained a periodic timer. | Pause their timeline once the run settles. |
| Git metadata | Installing a watcher reran a directory lookup already performed by status. | Reuse the repository's cached Git directories, which are invalidated on status errors. |
| Agent discovery | MCP always requested detailed workspace status, even when agents only needed IDs and component names. | Optional `list_workspaces(detail: false)` through both MCP and generic CLI calls; existing default behavior is preserved. |
| Console teardown | UI testing exposed the Swift 6.2 isolated-deinit back-deployment crash in the console's ownership chain. | Use nonisolated destruction for holders that need no actor-bound cleanup; explicit shutdown still owns task/watcher cleanup. |

## Measurement method

The measurements use an Apple M4 Max, macOS 26.3 and Xcode 26.3. Both baseline and candidate are Debug builds on the same machine. These are workload measurements, **not Release FPS, battery-life or universal speedup claims**. No fixed timing threshold is imposed on CI.

`StackPerformanceTests` measures 40 `/usr/bin/true` executions, eight full merges of 32 buffers containing 5,000 interleaved lines each, 40 bounded tail merges, and ten repeated searches of 5,000 ANSI-colored lines. The search comparison uses the old uncached filtering operation and the new cached operation on the same data in the same process.

`scripts/benchmark-workspace-performance.py` launches an isolated Debug preview with 16 real services, each producing a deterministic 5,000-line burst. It waits for ingestion, then samples 20 requests per workload over one persistent Unix-domain connection. Both builds return the same requested line counts. The fixture is stopped and removed afterward; personal workspace definitions and installed apps are untouched.

Run these workloads serially with other integration fixtures. Separate preview roots isolate storage, but lane allocators still share the machine's TCP port space.

## Results

Final candidate measurements were collected after the build and regression workloads finished. Times below are milliseconds; speedups compare medians.

| Workload | Baseline median / p95 | Candidate median / p95 | Median change |
| --- | ---: | ---: | ---: |
| Short command, 40 samples | 29.610 / 31.603 | 1.775 / 2.047 | 16.7× faster |
| Full merge, 32 × 5,000 lines, 8 samples | 900.202 / 931.533 | 172.255 / 175.331 | 5.2× faster |
| API: latest 200 of 80,000 retained lines, 20 samples | 214.857 / 223.039 | 2.243 / 2.596 | 95.8× faster |
| API: unchanged timestamp poll, 20 samples | 217.338 / 231.203 | 1.192 / 1.352 | 182.3× faster |
| API: detailed workspace inventory, 20 samples | 1.738 / 2.113 | 1.390 / 1.552 | 20% lower latency |
| API: ping control, 20 samples | 0.204 / 0.308 | 0.348 / 1.477 | 0.144 ms higher median |

The unchanged ping path did not improve; its small absolute variation is a reminder that these are single-machine samples. Log responses still contain 200 lines, and unchanged polls still contain zero lines. Their serialized response sizes are approximately 18.7 KB and 1.8 KB respectively, so the log improvement comes from avoiding unnecessary work rather than removing requested content.

Within the candidate process, repeatedly filtering 5,000 ANSI-colored lines took **21.048 ms uncached versus 1.165 ms cached** (18.1× faster; p95 22.262 versus 1.261 ms, ten samples each). This is a warm-cache comparison, not first-query latency. Directly merging a 200-line tail from 32 full buffers took 0.251 ms median / 0.269 ms p95 over 40 samples.

The execution-map and navigation changes remove repeated work structurally; visual interaction was checked, but no numeric frame-rate or energy improvement is claimed.

## Verification

- **232 selected XCTest tests passed**, covering the changed runtime, logs, Git, workspace/lane controls, runners, terminal lifecycle, MCP, PR and repro integration. The opt-in performance test also passed separately with the final source.
- **CLI/MCP integration passed across all 65 tool schemas**, including compact inventory, workspace/component edits, stale-save/type validation, lane lifecycle, run/wait/logs, and removal preserving project files and Git history.
- **Native UI checked in an isolated Debug preview:** an eight-process workspace map with shared dependencies and two lanes; selection and Focus; a full 5,000-line ANSI console; active filtering as new Unicode output arrives; clearing filters and switching services; closing the console while services remain running.
- Debug and Release builds passed. The repository's `scripts/install-local.sh --build-only` path signed and verified the Release app with the existing local development certificate; its headless help and `tools list_workspaces` commands loaded successfully. The installed app was not replaced. Release uses the existing Xcode 26.3 `PerfInliner` workaround documented in [BUILD.md](BUILD.md).

The first expanded run caught inherited signal settings affecting exit codes; the corrected process runner passed the final suites. UI checks also exposed and verified the console ownership-chain teardown fix. A lane fixture initially overlapped another fixture's TCP port allocation; the final integration run was serial. Existing test teardown still emits SQLite warnings when a temporary database is unlinked while references remain; the selected assertions pass, but this audit does not claim to resolve that fixture-lifecycle warning.

## Reproduce

```sh
TEST_RUNNER_CINDERDECK_PERFORMANCE_AUDIT=1 xcodebuild test \
  -project Cinderdeck.xcodeproj -scheme Cinderdeck -configuration Debug \
  -destination 'platform=macOS' -derivedDataPath .build/development \
  -only-testing:CinderdeckTests/StackPerformanceTests \
  -parallel-testing-enabled NO \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=

python3 scripts/benchmark-workspace-performance.py \
  --binary '.build/development/Build/Products/Debug/Cinderdeck Debug.app/Contents/MacOS/Cinderdeck' \
  --output .build/workspace-performance.json

python3 scripts/agent-controls-e2e.py \
  --binary '.build/development/Build/Products/Debug/Cinderdeck Debug.app/Contents/MacOS/Cinderdeck'
```

The XCTest regression suites cover stable merge/tail ordering including timestamp ties and empty inputs; cursor filtering and clock adjustments; Unicode/ANSI equivalence; cache invalidation; workflow step ordering after reload; concurrent command output/exit isolation; cancellation and descendant termination; and console lifecycle/navigation.

## Scope and remaining measurement work

The audit also inspected history search/thumbnail caching, recording buffer configuration, process/socket transport, and existing PR concurrency tests. History search already runs off the main thread and thumbnails have bounded memory caching. This change does not alter recording quality, frame rate, encoder selection, capture permissions, or media export algorithms.

Cold thumbnail bursts, GPU-heavy recording/export, and end-to-end Release frame pacing still need dedicated hardware workloads before changing their concurrency or quality budgets. Existing timestamp service-log cursors retain their public format; this is not a new lossless streaming protocol. Log files remain the full-output source when bounded in-memory history is insufficient.


## Lane creation: October 6, 2026

Multi-repository lane creation previously discovered, planned and materialized
repositories serially. The creation sheet also requested full working-tree status
just to display the current branch, competing with Git monitoring and network
fetches on the same per-repository queue.

Creation now runs off the main actor, deduplicates repository discovery, combines
root/common-directory reads, and reuses fresh branch metadata within one request.
Repository discovery and planning have at most four operations in flight.
Independent repository checkouts and submodule initialization have at most four
workers; repositories sharing a Git common directory remain serialized. Explicit
base commits are pinned before mutation and use Git's atomic `-b` guard without
repeating remote queries and revision resolution.

The sheet and workspace-settings branch selectors read only local references.
Current-branch labels use `symbolic-ref` (including unborn branches) or the detached
HEAD commit, without scanning working-tree files or waiting behind background
status/fetch work. Foreground branch reads also have a four-command limit.

Active checkout workers finish or acknowledge cancellation before rollback.
Recovery inspections/removals run in an awaited uncancelled task so cancellation
cannot bypass cleanup. Modified partial worktrees retain their recovery record;
reused/adopted worktrees and original checkouts are preserved.

### Measurements

An Apple M4 Max running macOS 26.3 and Xcode 26.3 created five lanes from four
real disposable repositories containing 2,500 tracked files each (10,000 total).
Both builds were Debug on the same machine. Fixture generation, assertion reads,
and teardown are outside the timed creation operation. No network, submodules,
checkout hooks or setup commands were present. Baseline: merged lane-creation
implementation at `339e37e44582fbe1ace9ec227587dd1e94aa7c75`.

| Four-repository creation | Median | Maximum of five samples |
| --- | ---: | ---: |
| Before | 1,789.270 ms | 1,937.809 ms |
| Final candidate, after builds/checks finished | 732.357 ms | 759.560 ms |

The final median was **59% lower (2.44 times faster)**. Two earlier candidate runs
had medians of 776.481 ms and 1,014.228 ms, showing variation with host workload.
These are fixture measurements, not a latency guarantee for personal repositories.
Large checkouts, custom checkout hooks, recursive submodule downloads, configured
file copies and optional setup/install commands can still dominate elapsed time.

### Verification and reproduction

- 68 selected XCTest tests passed (67 lane regressions plus the opt-in benchmark).
  New gate-based tests prove independent checkouts overlap with a four-worker cap,
  cancellation drains workers before cleanup, and failure preserves hook-created
  files while cleaning the other owned destinations. Timing is never a CI threshold.
- Native Debug and Release builds passed. `scripts/build-unified.sh` assembled and
  verified the Debug app with the previously verified, unchanged bundled runtime.
- Manual UI creation in the uniquely identified disposable app showed all four
  current branches and configured bases, listed branches, accepted a one-time base
  override, and created a named lane. All 10,000 files and exact selected commits
  were verified on disk. Original branches and saved defaults were unchanged.

```sh
TEST_RUNNER_CINDERDECK_LANE_PERFORMANCE_AUDIT=1 xcodebuild test \
  -project Cinderdeck.xcodeproj -scheme Cinderdeck -configuration Debug \
  -destination 'platform=macOS' -derivedDataPath .build/development \
  -only-testing:CinderdeckTests/StackLaneCreationPerformanceTests \
  -only-testing:CinderdeckTests/StackLaneTests \
  -parallel-testing-enabled NO COMPILER_INDEX_STORE_ENABLE=NO \
  'OTHER_SWIFT_FLAGS=$(inherited) -Xllvm -sil-disable-pass=PerfInliner' \
  CODE_SIGNING_ALLOWED=NO
```

Set `TEST_RUNNER_CINDERDECK_LANE_PERFORMANCE_FILES` to change the number of files
per repository. The benchmark prints all five samples and verifies lane readiness,
repository count, pinned commits and unchanged original branches.

## Lane creation modal: October 7, 2026

The creation sheet previously rediscovered repository roots and resolved symlinks
while evaluating its body, including after every lane-name edit. Repository rows
and their branch menus also rebuilt when unrelated form fields changed.

The sheet now discovers one repository snapshot on a background executor, leaving
the name field usable while discovery runs. Rendering, button eligibility and
submission use that snapshot. The repository list skips updates when its bases,
current branches and progress are unchanged. A new presentation discovers fresh
filesystem state, and the lane store still validates current Git metadata before
mutations. Branch menus query reference names without reading every branch's
commit subject or sorting by commit date. Explicit repository base revisions are
pinned with the existing four-reader concurrency bound.

Creation reports each repository's checkout, submodule initialization and readiness,
followed by file copying, saving, workspace loading, setup and service startup.
The sheet shows elapsed time throughout. Repository readiness does not imply that
setup or the complete lane has finished; failed creation reports its cleanup stage.

In a disposable fixture with four repository roots, 64 services and 64 tasks,
the former discovery work cost a median **28.279 ms per edit** across ten samples.
The new one-time background snapshot took **10.474 ms**. These measure repository
discovery, not native UI frame pacing. The four-repository/10,000-file checkout
benchmark measured a **633.623 ms** median and **679.307 ms** maximum across five
samples (baseline on this run: 669.432 ms median). Host workload affects these
timings; hooks, submodules, file copies and setup commands remain additional work.

All 68 existing lane regressions passed. Four presentation tests passed, covering
snapshot freshness, aliases and shared folders, branch reference names, truthful
checkout progress and progress forwarding through the reviewed creation/setup
path. Both opt-in benchmarks passed. The whole-app builder rebuilt native Debug,
bundled the existing runtime, and passed bundle identity and signature verification.
Manual typing responsiveness in the running app and performance on personal
repositories have not been profiled.

## Unified application audit: October 22, 2026

This pass audited the current working tree, including its existing uncommitted
product changes. Baseline copies and validation output are under
`.build/performance-audit-20261022/`. All fixtures use disposable data; the installed
application and live stores were not used. Independent changes in five other
source/test files appeared during the audit and were preserved; the final checks
and runtime build ran after those edits.

### Coverage and changes

| Surface | Finding and resulting behavior |
| --- | --- |
| Native service logs | Timestamp-filtered tails filtered the entire retained buffer before taking the last requested lines. They now walk backwards and stop after enough matches, preserving arrival order even after clock changes. Partial output is decoded for readiness only while a configured readiness expression still needs it. |
| Native history thumbnails | Concurrent dispatch allowed an unlimited number of image/video decoders. An operation queue now runs at most four, with an autorelease pool per decode. The memory cache stores one identity/image per record; eviction releases the identity metadata too. Generated images enter the cache once, charged by decoded pixels rather than JPEG bytes. |
| Exact managed session streams | Lifecycle changes in unrelated sessions caused another exact-session projection. The event source now receives the thread ID and the invalidation filter checks it. Ownership changes and durable watermark replay remain supported. |
| Workspace activity summaries | Counting older agents read each canonical shell, then the four displayed summaries read those shells again. Summaries reuse the shells from the same transaction. Page grouping uses indexes instead of repeatedly filtering every saved session for each context. Older-agent counts and generation boundaries remain intact. |
| Sidebar preferences | Every mounted session list read and parsed the same local storage document and repeated that work for local preference updates. Consumers now share one subscribed snapshot per execution computer and installation, with key-filtered storage events and listener cleanup. Updates remain shared when persistence fails. |
| Sub-agent navigation | Collapsed groups mounted every descendant and its sortable controls. Descendants now mount on first expansion or selected-path reveal. Once mounted, their disclosure state survives collapsing a parent. Search, ordering, drag/drop, archived ancestors and exact links retain regression coverage. |
| Existing transport and timelines | Inspected bounded recent-history snapshots, catch-up budgets, event buffering and desktop/mobile LegendList timelines; ran the v2 transport gate against the active path. |
| Existing background work and media | Inspected native Git refresh limits, event-driven log reads, incremental recording logs, preview diagnostic retention, renderer background throttling, history preloads, capture frame queues and encoding configuration. Capture quality and frame-rate settings remain workload choices; no hardware speedup is claimed for these inspected paths. |

### Measurements

Measurements used the same local machine and disposable synthetic fixtures.
They establish costs for these operations, not overall application speed, Release
frame pacing, energy use or peak memory.

| Workload | Before | After | Interpretation |
| --- | ---: | ---: | --- |
| Mount a collapsed group with 500 sub-agents, median of seven jsdom samples | 340.436 ms; 501 session links mounted | 6.156 ms; one session link mounted | About 55 times faster mounting in this fixture. Both runs used the same current preference hook; only the session component was replaced with its saved baseline source for comparison. |
| Last 200 timestamp-matching lines of 5,000 retained lines, median of 50 Debug actor calls | 0.531 ms | 0.046 ms | About 11.5 times faster. The reference actor runs the former filter-then-tail operation on identical retained lines; every result is compared for equality. |
| 100 contexts with six saved sessions each | 1,000 shell reads | 600 shell reads | 40% fewer canonical reads, retaining 400 visible provider-record summaries and all older-agent activity counts. |
| 1,000 unrelated run updates while observing one exact session | Unrelated updates invalidated the subscription | One initial shell read; no subsequent projection | Consumed-stream regression, not a latency benchmark. |

The broad native workload also retained its existing merge/search performance:
32 buffers of 5,000 lines merged in 169.759 ms median; taking a 200-line merged tail
cost 0.244 ms median. These are observations of existing optimizations, not gains
attributed to this pass.

### Validation

- 52 native tests passed across thumbnails, log buffers/filtering, recording
  lifecycle and opt-in performance workloads. After the final log-loop refinement,
  the 13 applicable log/benchmark tests passed again.
- All 13 runtime workspace package typechecks passed, including desktop, server,
  web, companion and shared packages. Focused runtime lint passed with one existing
  session-history effect warning.
- `scripts/build-unified.sh` rebuilt the runtime and assembled the complete Debug
  app; the final assembly uses a normal native build, with bundle identity and
  recursive signature verification. The artifact is
  `.build/performance-audit-20261022/app/Cinderdeck Debug.app`. It was not installed
  or launched for interactive profiling.
- The active v2 transport gate passed 297 tests in 18 files.
- The broader web navigation suite passed 316 tests; seven failures in existing
  PR/router/navigation fixtures reproduced with the saved pre-audit source.
  The optional mounting benchmark is skipped without its environment flag.
- The broader server integration selection passed 51 tests; two existing failures
  reproduced with the saved pre-audit source: the external-session migration
  fixture recreates an existing table, and a native integration guard fixture
  expects an older access result. These failures were not hidden or changed.

Reproduce the targeted checks from `agent-runtime/`:

```sh
pnpm typecheck
node_modules/.bin/vp run test:perf:v2-wire
(cd apps/server && ../../node_modules/.bin/vp test run \
  src/deckhand/ManagedSessions.test.ts src/deckhand/ManagedSessions.scalability.test.ts \
  src/deckhand/ThreadContext.test.ts)
(cd apps/web && ../../node_modules/.bin/vp test run --project unit \
  src/deckhand/WorkspaceSessions.test.tsx src/deckhand/WorkspaceSidebar.test.tsx \
  src/deckhand/useWorkspaceSidebarPreferences.test.tsx)
```

The mounting benchmark accepts `CINDERDECK_PERFORMANCE_AUDIT=1`, optional
`CINDERDECK_PERFORMANCE_REPORT=/absolute/report.json`, and the test-name filter
`-t 'measures collapsed session mounting'`. The native diagnostic runs with
`TEST_RUNNER_CINDERDECK_PERFORMANCE_AUDIT=1` and
`-only-testing:CinderdeckTests/StackPerformanceTests` using the Xcode command above.

### Measurement boundaries

Interactive Chromium/native frame pacing, cold-launch tracing, sustained provider
bursts, long recording/export workloads and device performance remain unprofiled.
Collapsed descendants remain mounted after their first expansion to preserve nested
state. Workspace activity counts still inspect saved agents in the requested
contexts, so their cost grows with that history; returning four summaries does not
make the complete activity query constant-cost. Thumbnail concurrency and cache
accounting are structural improvements, not a measured RSS or GPU reduction.

### Integration onto current main: October 26, 2026

The audit changes were rebased onto the current product implementation, preserving
session pinning and sibling reorder snapshots. Main already reused canonical
shells for displayed activity summaries, so that existing API and its 600-read
scalability gate were retained. The remaining server change adds indexed grouping
and filters exact-session invalidations at the event source. Original audit
timings and validation counts above describe the October 22 fixture run.
