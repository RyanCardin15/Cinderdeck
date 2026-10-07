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
