# Building the unified Cinderdeck app

Cinderdeck is one installed macOS application. The native app retains its identity, capture permissions, preferences, global shortcuts, menu/status bar, workspace services, control socket, and Sparkle updater. Its main workspace window is the T3-derived React agent shell, with the existing Chromium preview and recording runtime. Native capture, annotation, history, and preference tools remain available through that shell.

The native app launches a private `Contents/Resources/AgentShell.app/Contents/MacOS/AgentShell` child. This bundle is shipped inside Cinderdeck; it is not a second product to install. Its identifier is `com.ryancardin.cinderdeck.agentshell`, while the outer app remains `com.ryancardin.cinderdeck` (`com.ryancardin.cinderdeck.debug` for Debug). The internal bundle does not register URL schemes. Native Cinderdeck owns updates for the entire bundle; AgentShell's independent updater is disabled in native-host mode.

## Build and assemble

Clone the Cinderdeck repository normally. The maintained T3-derived source is included as tracked files under `agent-runtime/`, with full history and licenses. Use Xcode 26.2 or later and Rust/Cargo. The builder installs frozen dependencies and bootstraps the supported Node toolchain inside the clone when needed. It does not fetch a different harness revision.

```bash
./scripts/build-unified.sh \
  --output-dir /absolute/path/to/a/delivery-directory \
  --configuration Debug --arch arm64
```

The command runs the runtime's existing desktop artifact builder with `CINDERDECK_NATIVE_SHELL_BUILD=1`, targeting an unpacked macOS app. Node's directory and the runtime's `node_modules/.bin` lead that build's `PATH`. It builds native Cinderdeck with the documented Xcode performance-inliner workaround, copies both products into a fresh staging directory, and verifies the executable and bundle identifiers before signing.

To assemble already-built products for manual validation, supply either or both prebuilt apps:

```bash
./scripts/build-unified.sh \
  --output-dir /absolute/path/to/a/fresh-delivery-directory \
  --configuration Debug --arch arm64 \
  --native-app '/absolute/path/to/Cinderdeck Debug.app' \
  --agent-shell /absolute/path/to/AgentShell.app
```

The inputs are copied; they are not modified. Missing prebuilt products are built normally. `--arch` accepts `arm64`, `x64`, or `universal`, and supplied products must contain the requested architecture. `--dry-run` validates inputs and prints the plan without building, copying, or signing. Existing output apps are refused. A failed build retains its staging directory and logs for inspection.

This command does not install, launch, replace a live app, reset permissions, create a certificate, or publish an update. It produces one app for manual validation. `build_and_run.sh` and `install-local.sh` use this same packager by default. `--runtime-source` is an optional maintainer override, never a prerequisite for a clone.

## Signing

Debug defaults to ad-hoc signing for disposable manual output. Such builds do not establish a persistent permission identity. To preserve a local certificate identity, explicitly provide an existing identity through `--signing-identity` or `CINDERDECK_SIGNING_IDENTITY`. Release requires an exact existing certificate name or SHA-1 fingerprint; it refuses ad-hoc signing and does not create a missing certificate.

```bash
./scripts/build-unified.sh \
  --output-dir /absolute/path/to/a/fresh-release-directory \
  --configuration Release --arch arm64 \
  --signing-identity 'Your Existing Code Signing Identity'
```

`CINDERDECK_SIGNING_KEYCHAIN` selects an existing keychain; it defaults to the login keychain. The packager signs nested Mach-O code and bundles inside-out, first AgentShell, then native helpers including Sparkle, then the outer app. It preserves existing helper entitlements, permits Electron's executable memory, and resolves the native entitlement bundle-ID variables for the selected configuration. Local/ad-hoc identities require library-validation exceptions for the internal Electron runtime and native Sparkle loading. Apple-issued signatures retain the declared entitlements without adding that local exception.

The completed bundle and AgentShell receive strict recursive signature checks. Release also requires a certificate-based designated requirement. Local signing uses `--timestamp=none`. Distribution sets `CINDERDECK_SIGNING_TIMESTAMP=--timestamp` for Developer ID signatures, including nested runtime code. This command does not notarize, assess Gatekeeper acceptance, generate a signed Sparkle feed, or validate a public release. Follow the release/signing procedures separately before distribution.

## Runtime and authority boundaries

The native host passes the exact running control socket, current installation identity, and `development` or `release` channel to its owned child. Agent state lives in `AgentRuntime` below that native control directory, with a separate `Profile` subdirectory. Previous standalone runtime databases and native capture history retain their own storage. Provider authentication stays with the configured CLI; a separate agent data directory is not an authentication sandbox or a credential migration.

Parent-to-child route/activate/quit messages use the captured process's stdin. Child readiness, user Quit requests, and allowlisted native-tool requests use bounded stdout markers. Workspace routes are checked against the current native catalog; no arbitrary URLs, paths, or executable commands are accepted. Native Quit retains its running-work confirmation and waits for the captured child to close its backend pool. It does not terminate processes by name or discover unrelated PIDs.

Native-tool requests can open workspace/lane-map, history, preferences, capture, recording, annotation, or updates. The `workspace-setup` surface opens the existing discovery and project-check wizard without a selected workspace. `workspace-editor` requires an exact source workspace ID: no mode opens the definition editor, while `services`, `tasks`, or `workflows` opens the existing section and its editors. It refuses lane snapshots instead of editing an inferred owner. `execution-map` requires an exact workspace or lane ID and opens the full native task/workflow/process visualization. These tools reuse the existing native supervisor and editor sheets; closing the tool returns focus to the same agent-shell route. Capture modes and preference categories are explicitly validated. A recording opened with an exact workspace selects that workspace's native recording log scope. Actual capture and permission requests remain user actions. The backend socket UI method additionally requires the current installation identity and the private live-shell capability; that capability is not a renderer/provider credential. These UI methods do not add provider MCP permissions or general command execution.

The embedded workspace keeps Services, Tasks, Workflows, Lane map, Runs, Recordings, Agents, and Pull requests in its own section bar, retaining the selected workspace or lane. Workspace entry points open Services by default. Global tools remain available under All views. The workspace header and operational panels use the native workspace palette and compact controls. The `workspace-terminal` native-tool surface requires an exact workspace or lane ID and no mode; it opens the existing native service-log terminal without accepting a command.

The embedded workspace keeps Services, Tasks, Workflows, Lane map, Runs, Recordings, Agents, and Pull requests in its own section bar, retaining the selected workspace or lane. Workspace entry points open Services by default. Global tools remain available under All views. The workspace header and operational panels use the native workspace palette and compact controls. The `workspace-terminal` native-tool surface requires an exact workspace or lane ID and no mode; it opens the existing native service-log terminal without accepting a command.

Native Cinderdeck remains the only owner of workspace/lane service processes, ports, operational logs, runs, and native recordings. The agent runtime owns its threads, provider sessions, chat, diffs, and Chromium preview lifecycle. Shared-service aliases carry their actual owner workspace and optional canonical service target; a lane does not acquire a separate owner merely because it displays a shared service. Checkout writer admission coordinates agent activity, but is not operating-system isolation. Local provider sessions still require installed, authenticated CLIs and their advertised capabilities. This packaging command does not sign in providers, grant third-party access, or prove their live behavior.

## Maintaining T3 updates

Maintain the agent runtime inside `agent-runtime/`. Reuse its adapters, contracts, WebSocket transport, Electron backend supervision, preview implementation, and artifact builder. Native-host and Cinderdeck feature modules contain the product integration; upstream changes still pass through the runtime's existing fork policy and patch audit. The native repository remains authoritative for Cinderdeck identity, permissions, operational resources, and whole-app updates. Updating the runtime alone does not update an installed unified app: rebuild, sign, and validate the complete outer bundle.

The patch audit runs from the included runtime and compares only its subtree against the preserved upstream baseline:

```sh
cd agent-runtime
node scripts/deckhand/upstream-maintenance.mjs audit
```

For an upstream rehearsal, first extract the runtime history in a disposable worktree. Never merge T3 directly into the native host root:

```sh
# From the Cinderdeck repository root; choose new branch and worktree paths.
git subtree split --prefix=agent-runtime -b maintenance/runtime-review
git worktree add /tmp/cinderdeck-runtime-review maintenance/runtime-review
# Run the existing rehearsal and acceptance procedure from that runtime worktree.
# Once reviewed and all required gates pass, import the exact accepted runtime commit:
git subtree merge --prefix=agent-runtime ACCEPTED_RUNTIME_COMMIT
```

The rehearsal command refuses to run from the embedded subtree. The old separate runtime repository is retained as historical source; it is not required to build or start Cinderdeck. Rebuild and validate the complete app after importing a runtime update.

Compilation and signature verification do not prove the integrated product. Manually validate one main window, exact workspace/lane navigation, native tool entry points, provider selection and resumed conversations, preview/recording, shared-service ownership, relaunch, and cancellation/graceful quit. The Debug preview harness scopes operational files, capture output and processing, history database/thumbnails, recording metadata/audio and annotation sidecars to `CINDERDECK_STACKS_PREVIEW_ROOT`. Volatile fixture defaults enable saving and history while disabling clipboard copying. They do not redirect every persistent Debug preference write. Keep that distinction explicit when conducting manual checks.
