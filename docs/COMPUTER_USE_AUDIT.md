# Computer-use and browser-cookie audit

Reviewed 2026-11-16. This audit covers the bundled Cinderdeck runtime, native helper, provider MCP discovery, and desktop browser profiles.

## Findings and changes

The runtime rebase removed the native computer-use implementation and MCP toolkit while retaining their docs and skills. The tools therefore could not reach threads. The restored implementation is adapted to the current Effect and MCP access layers, rather than reinstating an older runtime.

All 13 `computer_*` tools are registered for conversation callers. Native tools are listed on macOS; outside OAuth clients do not see or acquire them. The caller supplies the actual thread identity, and stopped runs cannot mutate apps. Existing per-app consent, process targeting, selected-window isolation, mutation leases and screenshot identity checks remain in force.

Deferring providers see `computer_list_apps` and `computer_script` immediately. Individual actions remain searchable, and a script can call the same actions without loading thirteen schemas up front. Pi's extension follows the same exposure choice. Image-bearing state and script results use MCP image blocks; their structured metadata does not duplicate base64. Failed scripts retain their last screenshot evidence.

The whole-app builder compiles and unpacks the native helper beside the backend, so installed builds do not depend on a developer checkout. Original Cua Driver and yabai notices are preserved and included in the bundled license configuration.

When a state read opens a previously stopped app, the returned process ID now identifies both the screenshot and the target shown to the agent. The next coordinate click can use that first screenshot. State reads reuse the window list for selection, batch each window's metadata into one accessibility request and reuse its title. Input and post-capture validation still read the current windows. The server formats each accessibility node once and uses the resulting snapshot for both display and comparison.

Cookie refresh source links were also removed by the rebase. Successful imports again save the source browser, source profile and destination together. The first hosted browser opening attempts a refresh once per environment, thread and profile during a renderer session, before the webview's first navigation. Concurrent tabs share their attempt. Reloads, crash recovery and panel remounts do not repeat it, including after an unsuccessful automatic attempt. **Preview menu → Refresh cookies** refreshes linked profiles and reloads the page after import. For an unlinked profile, it opens the source picker and import wizard directly in the preview. Clearing cookies disconnects the source and waits for in-flight imports so a queued refresh cannot restore the cleared login. Incognito does not import cookies.

## Research applied

| Guidance | Cinderdeck implementation |
| --- | --- |
| Prefer narrower browser/API tools when they cover the task; native computer use is the general fallback. [Anthropic tool combinations](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-combinations) | Retain page-aware preview tools alongside native app tools. The bundled skill recommends APIs and accessibility values before screenshot coordinates. |
| Coordinate inputs must use the image coordinate space and retain the screenshot scaling. Batch understood actions and inspect results. [Anthropic computer-use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) | Window-relative image pixels, screenshot/geometry identity validation, compact diffs, optional images, direct AX value edits and batched scripts. Screenshots cap both the long edge (1,456 px) and area (1.1 MP); square windows no longer exceed the conservative image budget. |
| Apple provides a bulk attribute API, including per-attribute error values. [AXUIElementCopyMultipleAttributeValues](https://developer.apple.com/documentation/applicationservices/1462051-axuielementcopymultipleattribute) | Fetch node attributes together. A failed or invalid target does not trigger sixteen additional failing IPC reads. Fallback reads honor the tree deadline. |
| An AX timeout set on one object does not configure other objects, including equal handles; the system-wide AX object sets the process default. [AXUIElementSetMessagingTimeout](https://developer.apple.com/documentation/applicationservices/1459345-axuielementsetmessagingtimeout?language=objc) | Set a 0.5-second helper-process default, keeping the existing root-object override. This bounds child-node messaging that previously inherited the system default. |
| Browser actions should wait for a specific actionable target and fail within a deadline. [Playwright actionability](https://playwright.dev/docs/actionability) | Keep the existing page-aware browser surface and native stale-target checks. Prefer checked element actions and bounded state polling to blind delays or replaying uncertain mutations. |

## Measurements and validation limits

The native fixture uses fictional text in an owned AppKit app. Three pre-merge runs each performed 100 text-only reads, 20 direct value edits and 16 functional checks, including screenshot size bounds and avoiding upscaling small windows. In-process read medians were 0.66–0.73 ms, p95 reads were 2.76–2.87 ms and median edits were 8.12–10.76 ms.

A separate AppKit fixture tested the production helper across process boundaries using its exact PID and two windows. Direct edits, Unicode selection and typing, keyboard shortcuts, background clicks, modifier clearing, screenshots and per-conversation window isolation passed. Across 20 text-only reads, median latency was 2.69 ms and the slowest read took 6.32 ms. The first state with a screenshot took 272 ms and a subsequent one took 107 ms.

A synthetic 1,200-node benchmark compared server-side formatting and diffing against `fc2d292` on Node 26.13.1. After warm-up, 41 alternating batches of 12 reads produced identical output. Median time for a full read fell from 0.515 to 0.315 ms (39%), and for an unchanged read from 0.571 to 0.331 ms (42%). These measurements exclude native IPC, model and network latency.

The complete nondeferred MCP catalog grows from 49,736 to 62,839 JSON bytes. Deferred clients receive only two native tool declarations initially; remaining computer actions are discovered on demand. The measured context budget records this feature cost rather than hiding it.

Automated checks cover native fixture operations, helper lifecycle/timeouts, first-screenshot targeting after launch, state diffs, thread isolation, script batching, MCP registration/image delivery, provider exposure, cookie refresh deduplication, explicit imports and clearing races. Validation with third-party apps, installed-app permission prompts and real browser logins remains open.
