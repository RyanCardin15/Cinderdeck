# The unified Cinderdeck app

Cinderdeck is the user-facing application and the authority for Workspaces, Primary checkouts, feature Lanes, repositories, Services, runs, capture and local installation. The maintained T3-derived runtime supplies agent conversations, provider adapters and their durable execution history. Its Chromium window is packaged as a private **AgentShell** inside the native app rather than a second app for the user to install or update.

The visible web fallback, boot splash and assistant timeline now use Cinderdeck names and marks. Connected conversation context stays in a compact toolbar above the existing upstream chat; these are presentation changes, not new provider execution claims.

The shared workspace/lane navigation must remain visible across Overview, Agents, Services, Lane map and saved evidence. A session belongs to its saved context; switching views must not silently select a different checkout. Native surface requests go through the bounded Main/native-host bridge. Delivery of a request means the native owner received it, not that a capture, permission request or operation succeeded. Native authority and ordinary remote browser capabilities remain distinct.

Sharing a running Primary API or MCP Service does not itself mean sharing that repository's checkout. The native lane definition and returned physical repository bindings determine which files an agent can use and which writer reservations are required. Display labels, branches and a lane-map link cannot establish repository ownership.

This is a local integration candidate. Packaging, cold start and the complete native journey must be checked on the final artifact before describing the whole app as working. The earlier interactive demo is a design reference, not evidence of live provider or checkout behavior.

## Runtime updates and identity

The checked upstream baseline is `31a9da179ed0763335f05681c577474aec5d2309`, recorded in [upstream-patches.json](upstream-patches.json). The existing candidate base at the start of unified integration was `71f8e55627f1bc8709fc3daf5eaea7c7e28b7c12`. That base SHA does not identify the complete unified implementation. Final builds record their source identity; keep the source SHA and packaged-artifact digest together in delivery evidence.

Keep both Git histories and review the registered seams when updating T3. A clean merge is insufficient: use the [upstream maintenance workflow](upstream-maintenance.md), preserving contract/migration compatibility, provider lifecycle, context scope, isolated stores, dependencies and real UI checks. The new desktop host code is separately owned under `apps/desktop/src/cinderdeck/`; shared upstream files retain their individual reasons and conflict policies.

`CINDERDECK_NATIVE_SHELL_BUILD=1` selects the private AgentShell packaging identity (`com.ryancardin.cinderdeck.agentshell`) and omits its independent URL protocols. Native Cinderdeck owns the outer app, update UI and installation. Standalone Deckhand packaging retains its existing identity. Local unsigned builds do not establish signing, notarization, clean-machine installation or a production updater feed; those remain [release gates](packaging.md).

The existing `deckhand` CLI command, `DECKHAND_HOME`, provider instance IDs, wire methods, internal `@t3tools` package names and bootstrap protocol identifiers remain compatibility names. User-facing backend startup/help now says Cinderdeck. Do not rename persistent identifiers or move existing stores to make the displayed brand match. Upstream cloud services and release destinations must not become enabled as a side effect of embedding the runtime.

## Durable source checkout

The unified runtime is a durable linked Git worktree at `/Users/ryancardin/Src/CinderdeckAgentRuntime` on `codex/cinderdeck-unified`, sharing the permanent fork history at `/Users/ryancardin/Src/Deckhand/.git`. It was moved with Git's worktree command, retaining tracked changes, untracked source and local dependencies. The native app and runtime retain separate source histories even though the packaged user experience is one Cinderdeck app.

The sibling source location keeps another Git repository out of the native Cinderdeck tree. Packaged runtime binaries and build caches remain generated assets; source modules and the maintenance manifest remain versioned. The final app embeds its runtime resources and does not load source files from this checkout.

## Choose an agent provider

The unified picker offers **Codex**, **Claude**, **Cursor CLI** and **Copilot CLI** as distinct configured instances. Cursor CLI uses the existing ACP registry driver (`cursor_cli`, official agent ID `cursor`, local `agent` executable). Copilot CLI uses the same driver (`copilot_cli`, official agent ID `github-copilot-cli`, local `copilot`). The original Cursor SDK instance remains separate; choosing Cursor CLI must never fall back to it or to Codex.

Only a native-host profile without a settings file and without prior project/thread history receives the additional CLI defaults. Existing disabled, renamed or explicitly configured instances remain unchanged. An unavailable local executable stays unavailable; checking readiness does not silently install it. The ACP catalogue is obtained through the existing bounded cached official-registry path. Older Cursor builds are refused unless their explicit `help acp` output confirms ACP support, since an unrecognized positional command can otherwise be interpreted as a chat prompt.

Model choices come from the actual provider catalogue. ACP's **Default** placeholder means no model catalogue was discovered; it is not a verified model name. Installation and a successful protocol handshake do not prove account authentication, subscription access, quota or a completed turn. Cursor's declared login method is **Cursor Login**. Copilot can create an empty ACP session while authentication remains unknown; keep that state honest until the actual provider supplies evidence.

Current official startup interfaces are [Cursor `agent acp`](https://prod.cursor.com/docs/cli/acp) and [Copilot `copilot --acp --stdio`](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server). Authentication may need user interaction. Do not open login flows or send model prompts as a side effect of installing or listing providers.

## Session purpose and checkout access

**Code changes** uses the existing writer admission and reserves the exact selected repository checkout. **Read-only analysis** is available only for Codex: the saved session is an `observer` with `read_only` access, and its provider policy forces the actual Codex sandbox to read-only with approvals disabled. Every thread start, resume, fork and turn retains that policy. Analysis keeps the same native installation, checkout and physical repository validation but takes neither the local nor native writer reservation; multiple observers can inspect Primary while a writer owns its code changes.

MCP calls are separate from the provider sandbox. The server must deny mutation-declared tools for the authoritative saved observer and its provider-child context before handler effects. Other providers stay writers until their own enforcement is implemented and manually proven. Approval-required runtime mode alone is not an enforced read-only purpose. Reviewer sessions continue to use their isolated reviewer checkout and cannot override access through the ordinary launch field.

The optional launch `access` field is `read_only` or `write`. Omitting it preserves existing writer behavior and the encoding of historical operation keys. Existing session intent and receipts are never rewritten. Creating a new Lane still performs its legitimate checkout-creation operation; selecting analysis does not grant permission to bypass that operation's native lifecycle guards.

Before accepting the purpose selector, run a real Codex turn in a task-owned native context that deliberately attempts to write a disposable fixture file. Confirm that the write is refused, the file remains unchanged, there is no observer writer-reservation receipt, MCP mutations are refused, and a code-changes session can coexist under its own exact writer reservation. Follow-up and resume must retain enforcement. Manual packaged checks verified the read-only binding, native start/resume/turn sandbox policy, refused shell and patch writes, three completed scoped MCP reads and a completed provider-native helper with the same read-only policy. Saved preview snapshots were centrally denied. The native operation negative check was refused by upstream approval policy, so it does not prove that central denial path. No owned preview tab was available for the unsaved snapshot check.

## Create a Lane and start its agent

A successful native Lane creation can arrive before its branch display has refreshed. Before saving a new agent intake, the runtime briefly waits for two stable, hydrated native observations. Each observation must still match the creation receipt’s installation, Lane, physical repositories and resolved creation HEADs; a changed checkout, HEAD, branch or remote is refused. This waiting applies only before the immutable launch request is first saved.

An existing saved request that reports a changed context still needs **Review latest context**, confirmation and **Continue saved request**. The runtime does not refresh its saved revision automatically or repeat Lane creation. The fresh one-button create-and-launch flow still needs a manual check against the next packaged artifact; scoped source checks do not prove that UI journey.

## Stop an agent and release its checkout

The connected writer conversation has a **Stop agent** action independent of scheduling a review. It uses the existing exact managed source-stop operation, which checks the original accepted launch owner, the current provider-session identity and sole process attachment before stopping anything. Only a confirmed process stop and reservation release produces **Checkout released**. Conversation history, the lane and its files remain saved; a later message must acquire its own admission again.

A process shared with another conversation is not stopped by this action. The UI reports that its checkout remains reserved. An uncertain or lost response keeps release unconfirmed and does not automatically send another stop. Helpers cannot stop the managed parent from their inherited context. Read-only observers do not own writer reservations and do not display this writer-release action.

Interrupt and ordinary provider detachment have different semantics. Interrupt stops a turn while retaining the agent session. A detached multi-thread Codex process can remain alive for other conversations or idle cleanup, so detachment alone must not be described as checkout release. The final packaged manual check must confirm the direct action releases the exact task-owned writer while preserving its transcript and files; no new unit suite was added for this UI seam.

## External apps in a conversation

Enable Excel or add a Mac app in **Settings → External apps**. Its settings appear after enabling it. In a conversation, choose **External app** from the right panel, select the enabled profile, and attach the application and optional undocked WebKit Inspector windows on that conversation's computer. Both surfaces use the Cinderdeck theme and retain the conversation's Workspace/Lane context. Expand opens a larger view inside the app window, avoiding a separate macOS fullscreen Space that obstructs native-window activation.

The native helper is included and unpacked in AgentShell's packaged resources. Native controls remain explicit per window and captures stop when the panel is hidden. Microsoft Graph and Office APIs keep running in Excel; this integration mirrors and controls the actual host rather than recreating it. See [External apps](external-apps.md) for Mac requirements and setup. Actual Excel/OAuth and another-Mac acceptance still require the intended add-in and target machine.

## Organizing agents

Select a Workspace, then its Primary checkout or a feature Lane. The Agents view shows sessions for that exact context; global Overview and Agents navigation retain the selected computer, workspace, lane and saved identity pins. Start a session by choosing its repository, provider account, model and purpose. Provider readiness and sign-in requirements stay visible rather than silently selecting another provider.

A conversation retains the same workspace/lane tree and a compact session roster. Filters expand on demand in that roster. Provider-native helpers stay in the parent conversation, inherit its context and access policy, and cannot manage the parent writer. New feature creation waits for the native branch snapshot to stabilize while checking exact repository identity and unchanged HEADs before saving intake. Older saved requests retain their immutable scope and require explicit context review when it changes.

The packaged one-button check created a second feature lane, accepted its original operation key and launched a real Codex turn. Both lanes had distinct web worktrees and ports while API/MCP retained their Primary physical checkouts and ports; all Primary repositories stayed clean. The Stop agent check released both writer reservations while a separate observer remained connected. A follow-up resumed the saved writer conversation and reacquired its own reservations; the control recognizes the newer connected binding even when its provider-session ID is reused.

## Native UI credential boundary

`CINDERDECK_NATIVE_UI_TOKEN` is a launch-only capability for the trusted native UI path. It does not authorize provider commands, terminal shells, task processes or ordinary CLI helpers. Main excludes it from the backend environment. The runtime additionally wraps its existing platform process spawner, sanitizes both sides of pipelines, and scrubs terminal/provider environments after overrides. Explicit replacement environments remain replacements; ordinary variables and provider authentication are preserved. Renderer settings cannot reintroduce this capability into a child process.

## Manual acceptance evidence and procedure

These are manual checks, not new unit suites. The 2026-10-04 local provider/environment slice was checked with Node `24.19.0`, Cursor CLI `2026.10.01-e373342` and Copilot CLI `1.0.91`:

- Real isolated ACP initialization succeeded for both CLIs, with no authenticate request or model prompt. Cursor's empty `session/new` correctly refused authentication. Copilot created and cancelled an empty session and reported mode/permission options; it did not report a model catalogue. Evidence: `/tmp/cinderdeck-cli-acp-readiness.json`.
- A later, explicitly authorized Copilot check sent one prompt: “Reply with Cinderdeck ready. Do not read files or run tools.” With no model override, the real ACP session replied “Cinderdeck ready.” and ended with `end_turn`. No permission, client-tool or tool-call requests occurred. Its captured process exited successfully after cancellation and stdin closure. Evidence: `/tmp/cinderdeck-copilot-acp-prompt.json`. This proves that one Default-model turn worked in the checked environment; it does not establish a model name or guarantee another machine's authentication. Authentication refusal was not observed in this successful turn.
- A source backend started on task-owned `127.0.0.1:43173` with `/tmp/cinderdeck-cli-backend-readiness`. Its actual authenticated `server.getConfig` returned Codex and Claude ready, Cursor CLI installed/sign-in required, and Copilot CLI installed/authentication unknown. Evidence: `/tmp/cinderdeck-cli-backend-api.json`. This establishes readiness presentation, not new successful model turns.
- Actual child processes checked inherited environment, attempted credential overrides, explicit replacement environment and both legs of a pipeline. A real node-pty child was checked too. The native UI credential was absent in every child; ordinary/authentication canaries survived where intended, and the parent retained its credential. Evidence: `/tmp/cinderdeck-subprocess-manual.json`.
- Fresh scoped server typechecks and lint passed. CLI `--help` showed the Cinderdeck backend description without changing command IDs. The exact temporary backend was stopped with SIGINT, and its short-lived bearer file was removed. No live T3, Deckhand or Cinderdeck store was used.

For the next integration, repeat these checks against the final packaged runtime using a new task-owned profile, then archive evidence with the final source/artifact identity. Never publish startup logs containing pairing credentials. Read provider configuration using the isolated profile's own credential and the existing `server.getConfig` RPC; do not exchange the live desktop's bootstrap grant merely to obtain an API token.

The final native journey must separately verify workspace/lane switching, session start/follow-up/interrupt/stop, provider-supported helper tasks, exact repository writer ownership, native tools, saved evidence, restart and cleanup. Helper support must be observed for the selected provider, rather than inferred from another adapter. Paid-provider turns require deliberate authorization and real account availability. Missing sign-in, exhausted quota, unknown media provenance or unavailable native targets remain explicit limitations rather than successful outcomes.
