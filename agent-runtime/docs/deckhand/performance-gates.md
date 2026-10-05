# Bounded workspace overview gates

The current automated gate seeds an isolated SQLite registry with 100 workspaces, 500 lanes, 3,000 managed session bindings and 500 reported external registrations. It uses deterministic provider shell/record projections and the real relationship and external-session aggregate services. It never accesses live stores or native workspaces.

`ManagedSessions.scalability.test.ts` checks five independent 100-context pages. Every context has six managed session bindings, with accurate total counts and only its four newest canonical summaries returned. Each page reads one shared event watermark in a SQL transaction, projects at most 400 thread shells and 400 provider-record summaries, and reads no transcripts or complete event histories. Each external aggregate uses one bounded cached Hub resource snapshot, with no per-context native refresh. Registrations and heartbeats retain their fresh native identity checks. External counts remain scoped to each exact native lane generation; archived registrations do not contribute. The fixture found and fixed a grouping collision that had grouped sibling lane registrations under their primary workspace.

Consumed-stream tests also require recovery from an initially connecting cached catalog. Reported external summaries invalidate from a one-resource subscription to the existing shared Hub watcher; no per-context native polling returns. A sliding buffer retains at most one pending invalidation while a page projects.

A second test consumes the actual managed-context stream. Its initial and updated values both contain at most 100 contexts and 400 summaries. Unrelated events do not refresh the page. This proves bounded work per emitted update; it does not prove throughput under sustained provider-event bursts or coalesce every matching event.

`IntegrationHub.test.ts` adds an actual Unix-peer/SQLite catalog test with 600 resources. Selected workspace/context details come from the same authoritative catalog snapshot in a separate array capped at two. Paging never requires a separate per-row native request. Removed selected contexts disappear rather than retargeting to a different context. Native installation negotiation and the existing URL generation/installation guards remain authoritative.

The Overview requests 48 global catalog rows, at most 50 contexts from the selected workspace, and at most two selected detail records. Both pages come from the same cached snapshot; their combined response and deduplicated summary input stay at 100. The scoped page carries the authoritative total context and lane counts, so an off-page workspace does not falsely report zero lanes. Workspaces with more than 50 contexts have independent scoped pagination, while explicit primary/lane pins remain visible. Catalog pagination still describes the global catalog; it does not count repeated pins. `workspaceNavigation.test.ts` checks off-page scoped rows, independent paging, selected pins, deduplication, removed contexts and refused identity replacements. The Unix-peer Hub test consumes the scoped stream and proves the same bounds without extra native requests.

Run the focused gate from the server and web packages:

```sh
# apps/server
../../node_modules/.bin/vp test run src/deckhand/ManagedSessions.scalability.test.ts src/deckhand/ManagedSessions.test.ts src/deckhand/ExternalSessions.test.ts src/deckhand/IntegrationHub.test.ts
# apps/web
../../node_modules/.bin/vp test run src/deckhand/workspaceNavigation.test.ts
```

These tests establish structural bounds and correctness using isolated fixtures. They are not a measurement of live provider latency or a validation of a 500-lane browser, desktop, memory, scrolling or event-burst workload. Those real acceptance checks remain separate performance gates. No wall-clock threshold is used to turn a synthetic fixture into a product performance claim.
