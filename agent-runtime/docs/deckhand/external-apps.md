# Debug Mac apps in their real host

Start an agent conversation and ask it to open Excel, or open the right panel and choose **External app → Excel → Open Excel**. Excel is offered by default; existing disabled preferences remain disabled, and the chooser lets you enable it directly. It opens a session tab alongside Browser, Files, and Terminal, showing the live Excel window and its actual WebKit Inspector. The command palette’s **Debug an external app** opens the same session chooser. Settings also lets you add other Mac apps. Excel keeps the add-in, workbook APIs, and Microsoft sign-in. The helper uses public ScreenCaptureKit and Accessibility APIs; it does not inject code into Office or recreate its runtime in another browser.

## Agent control and testing

The agent and side panel share the same thread-scoped window connection. `deckhand_debug_open({bundleId:"com.microsoft.Excel"})` opens the installed app on the conversation's Mac and connects a single available window. If there are several windows, it returns choices without selecting a workbook. Use `deckhand_debug_attach` with the selected target ID. Agent attachments appear automatically in the side panel; other apps receive their own transient tabs without requiring a saved profile. Explicitly disabled profiles remain hidden.

For a test, ask the agent to open the app, read a screenshot, click or type into the chosen test document, then read again to check the visible result. `deckhand_debug_sessions` finds the same connections you selected manually. `deckhand_debug_command` supports click, right/double click, hover, drag, scroll, typing, focus, permission status and keyboard shortcuts: named keys, F1–F12, letters, digits and punctuation with Command, Option, Shift or Control (for example F2 to edit a cell, F9 to recalculate, Command-Shift-L for filters).

`snapshot` returns the window's accessibility outline without activating it: roles, names and values with `[eN]` references and normalized center coordinates. In Excel this includes the ribbon, Name Box and formula bar; in the add-in task pane it includes the WebKit DOM's text, buttons and fields; in an undocked Web Inspector it includes console messages and the console prompt. Pass a `ref` to outline a subtree. `press` activates a referenced element, and click or hover accept a `ref` instead of coordinates. References expire at the next snapshot. Outlines are bounded to 1,500 elements, three seconds and 120 KB, skip off-window content, and omit secure field values. The read following any input waits up to 600 ms for the window to repaint, so the agent sees the result of its action. The **Control window** checkbox governs your panel's mouse and keyboard; the agent uses its authenticated thread tools. Both require Accessibility on the app's Mac.

**Action history & diagnostics** retains the last 200 events in each panel, including input accepted/failed outcomes. The backend keeps 500 events and returns at most 100 per cursor read. Typed document contents are omitted from action history. Accepted input only confirms dispatch; verify the next screenshot or your application's actual logs before claiming a test passed. Existing workspace service logs and task/workflow runs remain available in their usual panels. Native app console/network output appears in the real Web Inspector; native action history does not invent app logs or an integration-test verdict.

Opening uses an exact installed bundle ID, never a shell command or document URL, and leaves authentication intact. If the app has no capturable window, open a test document on its Mac and refresh **Find windows**. Agent and UI disconnect release capture and leave the app running. Attachments and diagnostics are transient; record the window separately when you need durable video evidence.

## Connect Excel on Mac

1. On the Excel Mac, save your work and quit Excel. Enable inspection once:

   ```sh
   defaults write com.microsoft.Excel OfficeWebAddinDeveloperExtras -bool true
   ```

2. Reopen Excel and your add-in. Right-click inside the task pane and choose **Inspect Element**. Undock the Inspector into its own window. Microsoft's [Mac debugging guide](https://learn.microsoft.com/en-us/office/dev/add-ins/testing/debug-office-add-ins-on-ipad-and-mac) describes the supported Office installation and version prerequisites; Office installed from the Mac App Store does not support these instructions.
3. In Cinderdeck, open a conversation on the **connection computer** that runs Excel. Open its **External app → Excel** side-panel tab. Choose **Find windows** and deliberately select the application window and optional Inspector window. The filters in Settings match app names, bundle IDs, or window titles. **Show all Mac windows** temporarily expands the picker. Choose **Connect selected windows**.
4. Allow Screen Recording for Cinderdeck or its server host on that Mac in System Settings. Accessibility is needed for agent input or if you enable **Control window**. This feature captures no audio. Permission prompts and native sign-in dialogs stay on the host Mac.

Requires macOS 14 or newer on the connection computer. Desktop and server distributions include a universal Apple Silicon/Intel helper. For source development, build it once with `node scripts/deckhand/build-mac-external-debug.mjs`. Compilation requires Apple's command-line tools on the development machine; runtime use does not require a compiler.

## Excel on another Mac

Connect Cinderdeck to its authenticated server on the Excel Mac using the existing connection setup. Open a conversation on that connection; discovery, capture, and controls then run on that Mac. The web or desktop viewer may run on a different Mac. No WebKit debug port or separate CDP tunnel is required. Screen Recording and Accessibility permissions must be granted on the Excel Mac to the server host that runs the helper. Remote Mac and real Excel/OAuth acceptance remain separate validation gates from local WebKit fixture tests.

## View and debug

The actual Inspector provides DOM, Console, Network, Sources, breakpoints, paused local variables, and stepping. Enable **Control window** separately for each panel, click the appropriate Inspector tab or field, and use its normal controls. The text field below a panel sends text to its currently focused native field; **Return** sends the Return key. To evaluate JavaScript, click the Inspector console prompt first, send your expression, and press Return. Expressions run in the actual add-in and can change workbook data.

Controls activate the selected window on its Mac and move its pointer. The original host may therefore come to the front while controlling a local Mac. A viewer on another Mac stays separate. Click, right-click, double-click, dragging (for example selecting a cell range), typing, text paste, scrolling, and keyboard shortcuts with Command or Control are supported. Command-V pastes the viewer's clipboard as text; other shortcuts go to the Mac. Separate native dialogs must be handled on the host or selected explicitly. The live panels share only selected windows; they are window mirrors, not an Excel process embedded in the harness.

Capture is capped at three frames per second and 2048 × 1600 pixels. Frames are JPEG-encoded only when read and changed; unchanged frames are not re-sent from the helper or to the viewer. Reads do not overlap, and pause while the page, session panel, or selected App/Inspector view is hidden. Choose **Both** to view both windows together. Turn off **Live view** to pause a panel and disable its controls. Expand a panel for readable source text; Escape exits full screen. The frame remains available while its window is occluded. Closed or unavailable windows display a disconnected state and require deliberate reconnection.

**Disconnect** ends capture and control while leaving Excel and the Inspector open. Switching tabs or conversations keeps each conversation’s attachments separate. Closing the external app tab releases its attachments; disabling the app in Settings releases attachments opened in this viewer. Enabling a profile does not launch the host app or grant macOS permissions. Preferences belong to the viewer and survive reload; transient session IDs do not. Attachments created by the conversation’s agent automatically appear beside chat while the conversation is visible; **Already attached in this session** also lets you recover one manually. Idle sessions expire after 15 minutes, and restarting the server releases them. Detaching a native Inspector mirror does not alter the Inspector's breakpoints or resume its paused runtime: resume in the actual Inspector when needed.

Screenshots and Inspector output can include workbook data and credentials displayed by the app. They pass through the existing authenticated connection and are transient. They are not automatically stored as a Cinderdeck recording or build attestation. Native Mac mirroring does not expose structured WebKit console, source, or debugger RPC results; those appear in the real Inspector, whose visible text the accessibility outline can read.

## Add-in performance and benchmarks

Cinderdeck can measure what an add-in does while you or the agent use it: Office.js round trips, downloads and API calls, validation and other named steps, console errors, main-thread stalls, repaints, and the CPU and memory of Excel together with the WebKit processes that run its task pane.

### Install the probe (once per add-in repository)

The probe runs inside the add-in's own page, so it needs two development-only edits in the add-in repository. Cinderdeck serves the probe itself; the repository only points at it, and nothing is installed or published.

1. A dev-server proxy that forwards `/__cinderdeck` to Cinderdeck on the same Mac (port 47823, or `CINDERDECK_EXCEL_PROBE_PORT` when set for both). For the Yeoman Office webpack template:

   ```js
   devServer: {
     proxy: [{ context: ["/__cinderdeck"], target: `http://127.0.0.1:${process.env.CINDERDECK_EXCEL_PROBE_PORT || 47823}`, logLevel: "silent" }],
   },
   ```

   Vite uses `server.proxy` with the same target.

2. A loader as the first statement of each add-in page entry, such as `src/taskpane/taskpane.ts`, before code that calls `Office.onReady` or `Excel.run`:

   ```js
   if (process.env.NODE_ENV !== "production" && typeof document !== "undefined") {
     const probe = document.createElement("script");
     probe.src = "/__cinderdeck/excel-probe.js";
     document.head.appendChild(probe);
   }
   ```

   Vite projects use `import.meta.env.DEV` as the condition.

Ask the agent to "set up the Cinderdeck Excel probe": `deckhand_excel_probe` with `setup` inspects the repository (webpack or Vite, entry files, manifests, whether the hook already exists) and returns these edits for it to apply as an ordinary reviewable change. **External app → Excel → Add-in performance → Set up probe** shows the same snippets. Restart the dev server and reload the task pane afterwards. Same-origin proxying avoids certificate, CORS and mixed-content problems in Excel's WebKit view. Without Cinderdeck the script request fails quietly; production builds never include it.

The probe records `Excel.run` batches and each `context.sync` (duration, action count, failures with Office error codes), fetch and XMLHttpRequest status and timing, Resource Timing downloads with DNS/connect/TLS/first-byte/download phases and transferred bytes, navigation and paint timing, `performance.mark`/`measure`, console output, uncaught errors and rejections, and main-thread stalls longer than 50 ms. Name validation or business steps with `performance.measure`, or `__cinderdeckProbe.time("validate", () => validate())`. URLs lose query strings and fragments, common tokens are redacted, and request or response bodies, headers and cookies are never read. Until a conversation arms collection, the page keeps a bounded local buffer and only polls; nothing is stored. Collected events are transient, bounded to 20,000 per conversation, and expire after an hour without use. Console calls pass through the probe, so blackbox `cinderdeck-excel-probe.js` in Web Inspector to keep original call sites.

### Benchmark interactions

`deckhand_excel_benchmark` runs scripted steps against the attached Excel window: optional unmeasured setup steps, then measured click, press, type, key, drag, scroll, move, focus or wait steps, after warm-up iterations. A step lasts from native input dispatch until repaints, probe activity and outstanding Office.js or network work have been quiet for the settle time (600 ms by default), until a named `mark` or `measure` appears, or until its timeout. Cursor-sized repaints such as a blinking caret are ignored, and a region restricts repaint detection to part of the window, such as the task pane.

Each step reports p50/p95 distributions of duration, first repaint, `context.sync` count and time, requests and request time, transferred bytes, named measures, errors, longest stall, and average CPU and peak memory of Excel and its WebKit processes. During a run, repaint capture rises to 60 frames per second without encoding images, and process use is sampled every 200 ms. Reports are saved in Cinderdeck's state directory (the newest 100), so a later run can pass `baselineId`; a step regresses when its median is both 10% and 20 ms slower. Runs are asynchronous: start, then get by run ID or wait up to 55 seconds. The window's input is reserved for the run; screenshots and accessibility snapshots remain available. The panel's **Add-in performance** section shows probe status, live totals and saved reports.

Without the probe, a benchmark still measures repaint and process cost and says which metrics are missing. Without Screen Recording, it falls back to probe activity alone and says so. Benchmarks change the live workbook; use a test document. Results reflect this Mac, its Excel build and its network; compare runs made under the same conditions.

## Other Mac browser runtimes

The CLI and MCP CDP adapter remains available for an existing Chromium runtime on Mac, using an explicit loopback HTTP endpoint. It provides structured console/network diagnostics, execution-context evaluation, sources, breakpoints, and stepping. Preview is optional and refreshes at most once per second. Network diagnostics exclude request headers, cookies, and bodies, and common OAuth token forms are redacted. This adapter is separate from Mac Excel's WebKit integration.

The shared web/desktop interface exposes External apps. The separate React Native mobile client does not yet expose this session panel.

## Reproduce the native acceptance test

Build the helper, then run `node scripts/deckhand/start-mac-external-debug-fixture.mjs`. It creates an isolated AppKit/WKWebView application with an actual WebKit Inspector. Office APIs are explicitly simulated. If necessary, undock this fixture's Inspector. Run the `nativeExternalDebug.smoke.ts` command printed by the launcher. It verifies paired native JPEG streams, unchanged-frame suppression, real button/text acknowledgements, Cmd-A through a normal Edit menu, the accessibility outline and element press against the WebKit DOM, and detach without closing either window. Ctrl-C stops only the fixture owned by that launcher. It never changes Excel preferences or proves Graph OAuth success.

`node apps/server/src/deckhand/excelPerformance.smoke.ts` checks the probe and benchmark path in real WebKit without Screen Recording: a fixture WKWebView loads a simulated add-in from a simulated dev server whose `/__cinderdeck` proxy reaches the probe listener, then a benchmark presses two buttons and must report the expected `context.sync` counts, requests and measures. Office.js is simulated and window input uses the fixture's test channel, so native repaint and process metrics are reported unavailable there.
