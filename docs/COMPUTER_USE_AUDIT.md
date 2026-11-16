# Computer-use and browser-cookie audit

Reviewed 2026-11-16. This audit covers the bundled Cinderdeck runtime, native helper, provider MCP discovery, and desktop browser profiles.

## Findings and changes

The runtime rebase removed the native computer-use implementation and MCP toolkit while retaining their docs and skills. The tools therefore could not reach threads. The restored implementation is adapted to the current Effect and MCP access layers, rather than reinstating an older runtime.

All 13 `computer_*` tools are registered for conversation callers. Native tools are listed on macOS; outside OAuth clients do not see or acquire them. The caller supplies the actual thread identity, and stopped runs cannot mutate apps. Existing per-app consent, process targeting, selected-window isolation, mutation leases and screenshot identity checks remain in force.

Deferring providers see `computer_list_apps` and `computer_script` immediately. Individual actions remain searchable, and a script can call the same actions without loading thirteen schemas up front. Pi's extension follows the same exposure choice. Image-bearing state and script results use MCP image blocks; their structured metadata does not duplicate base64. Failed scripts retain their last screenshot evidence.

The whole-app builder compiles and unpacks the native helper beside the backend, so installed builds do not depend on a developer checkout. Original Cua Driver and yabai notices are preserved and included in the bundled license configuration.

Cookie refresh source links were also removed by the rebase. Successful imports again save the source browser, source profile and destination together. The first hosted browser opening attempts a refresh once per environment, thread and profile during a renderer session, before the webview's first navigation. Concurrent tabs share their attempt. Reloads, crash recovery and panel remounts do not repeat it, including after an unsuccessful automatic attempt. **Preview menu → Refresh cookies** retries manually and reloads the page after import; it explains that Integrations must connect a source when none is saved. Clearing cookies disconnects the source and waits for in-flight imports so a queued refresh cannot restore the cleared login. Incognito does not import cookies.

## Research applied

| Guidance | Cinderdeck implementation |
| --- | --- |
| Prefer narrower browser/API tools when they cover the task; native computer use is the general fallback. [Anthropic tool combinations](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-combinations) | Retain page-aware preview tools alongside native app tools. The bundled skill recommends APIs and accessibility values before screenshot coordinates. |
| Coordinate inputs must use the image coordinate space and retain the screenshot scaling. Batch understood actions and inspect results. [Anthropic computer-use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) | Window-relative image pixels, screenshot/geometry identity validation, compact diffs, optional images, direct AX value edits and batched scripts. Screenshots cap both the long edge (1,456 px) and area (1.1 MP); square windows no longer exceed the conservative image budget. |
| Apple provides a bulk attribute API, including per-attribute error values. [AXUIElementCopyMultipleAttributeValues](https://developer.apple.com/documentation/applicationservices/1462051-axuielementcopymultipleattribute) | Fetch node attributes together. A failed or invalid target does not trigger sixteen additional failing IPC reads. Fallback reads honor the tree deadline. |
| An AX timeout set on one object does not configure other objects, including equal handles; the system-wide AX object sets the process default. [AXUIElementSetMessagingTimeout](https://developer.apple.com/documentation/applicationservices/1459345-axuielementsetmessagingtimeout?language=objc) | Set a 0.5-second helper-process default, keeping the existing root-object override. This bounds child-node messaging that previously inherited the system default. |
| Browser actions should wait for a specific actionable target and fail within a deadline. [Playwright actionability](https://playwright.dev/docs/actionability) | Keep the existing page-aware browser surface and native stale-target checks. Prefer checked element actions and bounded state polling to blind delays or replaying uncertain mutations. |

## Measurements and validation limits

The native fixture uses fictional text in an owned AppKit app. Three runs each performed 100 text-only reads and 20 direct value edits, plus 16 functional checks, including screenshot size bounds and avoiding upscaling small windows. Read medians were 0.723–0.747 ms; p95 reads were 1.198–3.381 ms. Median edits were 7.783–9.271 ms. These are fixture timings, not third-party application or model round-trip measurements.

The complete nondeferred MCP catalog grows from 49,736 to 62,839 JSON bytes. Deferred clients receive only two native tool declarations initially; remaining computer actions are discovered on demand. The measured context budget records this feature cost rather than hiding it.

Automated checks cover native fixture operations, helper lifecycle/timeouts, state diffs, thread isolation, script batching, MCP registration/image delivery, provider exposure, cookie refresh deduplication, explicit imports and clearing races. Browser/device UI, real source-browser credentials, arbitrary third-party apps, and the external permission-responsibility chain require separate interactive validation; this audit does not claim universal performance or compatibility.
