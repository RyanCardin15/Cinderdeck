# Debug Mac apps in their real host

Start an agent conversation and ask it to open Excel, or open the right panel and choose **External app → Excel → Open Excel**. Excel is offered by default; existing disabled preferences remain disabled, and the chooser lets you enable it directly. It opens a session tab alongside Browser, Files, and Terminal, showing the live Excel window and its actual WebKit Inspector. The command palette’s **Debug an external app** opens the same session chooser. Settings also lets you add other Mac apps. Excel keeps the add-in, workbook APIs, and Microsoft sign-in. The helper uses public ScreenCaptureKit and Accessibility APIs; it does not inject code into Office or recreate its runtime in another browser.

## Agent control and testing

The agent and side panel share the same thread-scoped window connection. `deckhand_debug_open({bundleId:"com.microsoft.Excel"})` opens the installed app on the conversation's Mac and connects a single available window. If there are several windows, it returns choices without selecting a workbook. Use `deckhand_debug_attach` with the selected target ID. Agent attachments appear automatically in the side panel; other apps receive their own transient tabs without requiring a saved profile. Explicitly disabled profiles remain hidden.

For a test, ask the agent to open the app, read a screenshot, click or type into the chosen test document, then read again to check the visible result. `deckhand_debug_sessions` finds the same connections you selected manually. `deckhand_debug_command` supports click, right/double click, scroll, typing, focus, permission status and keyboard shortcuts, including Command-N/O/S/W/F/P. The **Control window** checkbox governs your panel's mouse and keyboard; the agent uses its authenticated thread tools. Both require Accessibility on the app's Mac.

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

Controls activate the selected window on its Mac and move its pointer. The original host may therefore come to the front while controlling a local Mac. A viewer on another Mac stays separate. Click, right-click, double-click, typing, text paste, scrolling, and common keyboard shortcuts are supported. Dragging is not supported. Separate native dialogs must be handled on the host or selected explicitly. The live panels share only selected windows; they are window mirrors, not an Excel process embedded in the harness.

Capture is capped at three frames per second and 2048 × 1600 pixels. Only changed image payloads are delivered to the viewer. Reads do not overlap, and pause while the page, session panel, or selected App/Inspector view is hidden. Choose **Both** to view both windows together. Turn off **Live view** to pause a panel and disable its controls. Expand a panel for readable source text; Escape exits full screen. The frame remains available while its window is occluded. Closed or unavailable windows display a disconnected state and require deliberate reconnection.

**Disconnect** ends capture and control while leaving Excel and the Inspector open. Switching tabs or conversations keeps each conversation’s attachments separate. Closing the external app tab releases its attachments; disabling the app in Settings releases attachments opened in this viewer. Enabling a profile does not launch the host app or grant macOS permissions. Preferences belong to the viewer and survive reload; transient session IDs do not. Attachments created by the conversation’s agent automatically appear beside chat while the conversation is visible; **Already attached in this session** also lets you recover one manually. Idle sessions expire after 15 minutes, and restarting the server releases them. Detaching a native Inspector mirror does not alter the Inspector's breakpoints or resume its paused runtime: resume in the actual Inspector when needed.

Screenshots and Inspector output can include workbook data and credentials displayed by the app. They pass through the existing authenticated connection and are transient. They are not automatically stored as a Cinderdeck recording or build attestation. Native Mac mirroring does not expose structured WebKit console, source, or debugger RPC results; those appear in the real Inspector.

## Other Mac browser runtimes

The CLI and MCP CDP adapter remains available for an existing Chromium runtime on Mac, using an explicit loopback HTTP endpoint. It provides structured console/network diagnostics, execution-context evaluation, sources, breakpoints, and stepping. Preview is optional and refreshes at most once per second. Network diagnostics exclude request headers, cookies, and bodies, and common OAuth token forms are redacted. This adapter is separate from Mac Excel's WebKit integration.

The shared web/desktop interface exposes External apps. The separate React Native mobile client does not yet expose this session panel.

## Reproduce the native acceptance test

Build the helper, then run `node scripts/deckhand/start-mac-external-debug-fixture.mjs`. It creates an isolated AppKit/WKWebView application with an actual WebKit Inspector. Office APIs are explicitly simulated. If necessary, undock this fixture's Inspector. Run the `nativeExternalDebug.smoke.ts` command printed by the launcher. It verifies paired native JPEG streams, unchanged-frame suppression, real button/text acknowledgements, Cmd-A through a normal Edit menu, and detach without closing either window. Ctrl-C stops only the fixture owned by that launcher. It never changes Excel preferences or proves Graph OAuth success.
