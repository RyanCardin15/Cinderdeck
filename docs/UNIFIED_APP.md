# Building the unified Cinderdeck app

Cinderdeck is one installed macOS application. The native app retains its identity, capture permissions, preferences, global shortcuts, menu/status bar, workspace services, control socket, and Sparkle updater. Its main workspace window is the T3-derived React agent shell, with the existing Chromium preview and recording runtime. Native capture, annotation, history, and preference tools remain available through that shell.

The native app launches a private `Contents/Resources/AgentShell.app/Contents/MacOS/AgentShell` child. This bundle is shipped inside Cinderdeck; it is not a second product to install. Its identifier is `com.ryancardin.cinderdeck.agentshell`, while the outer app remains `com.ryancardin.cinderdeck` (`com.ryancardin.cinderdeck.debug` for Debug). The internal bundle does not register URL schemes. Native Cinderdeck owns updates for the entire bundle; AgentShell's independent updater is disabled in native-host mode.

## Build and assemble

Use Xcode 26.2 or later, the runtime checkout's installed dependencies, and Node 24.13.1 or later within the Node 24 line. The source checkouts are explicit: this script does not fetch or select a T3 revision.

```bash
CINDERDECK_NODE_BINARY=/absolute/path/to/node24 \
  ./scripts/build-unified.sh \
  --runtime-source /absolute/path/to/the/runtime-checkout \
  --output-dir /absolute/path/to/a/delivery-directory \
  --configuration Debug --arch arm64
```

The command runs the runtime's existing desktop artifact builder with `CINDERDECK_NATIVE_SHELL_BUILD=1`, targeting an unpacked macOS app. Node's directory and the runtime's `node_modules/.bin` lead that build's `PATH`. It builds native Cinderdeck with the documented Xcode performance-inliner workaround, copies both products into a fresh staging directory, and verifies the executable and bundle identifiers before signing.

To assemble already-built products for manual validation, supply either or both prebuilt apps:

```bash
./scripts/build-unified.sh \
  --runtime-source /absolute/path/to/the/runtime-checkout \
  --output-dir /absolute/path/to/a/fresh-delivery-directory \
  --configuration Debug --arch arm64 \
  --native-app '/absolute/path/to/Cinderdeck Debug.app' \
  --agent-shell /absolute/path/to/AgentShell.app
```

The inputs are copied; they are not modified. Missing prebuilt products are built normally. `--arch` accepts `arm64`, `x64`, or `universal`, and supplied products must contain the requested architecture. `--dry-run` validates inputs and prints the plan without building, copying, or signing. Existing output apps are refused. A failed build retains its staging directory and logs for inspection.

This command does not install, launch, replace a live app, reset permissions, create a certificate, or publish an update. It produces one app for manual validation. It does not change the existing `install-local.sh` workflow.

## Signing

Debug defaults to ad-hoc signing for disposable manual output. Such builds do not establish a persistent permission identity. To preserve a local certificate identity, explicitly provide an existing identity through `--signing-identity` or `CINDERDECK_SIGNING_IDENTITY`. Release requires an exact existing certificate name or SHA-1 fingerprint; it refuses ad-hoc signing and does not create a missing certificate.

```bash
./scripts/build-unified.sh \
  --runtime-source /absolute/path/to/the/runtime-checkout \
  --output-dir /absolute/path/to/a/fresh-release-directory \
  --configuration Release --arch arm64 \
  --signing-identity 'Your Existing Code Signing Identity'
```

`CINDERDECK_SIGNING_KEYCHAIN` selects an existing keychain; it defaults to the login keychain. The packager signs nested Mach-O code and bundles inside-out, first AgentShell, then native helpers including Sparkle, then the outer app. It preserves existing helper entitlements, permits Electron's executable memory, and resolves the native entitlement bundle-ID variables for the selected configuration. Local/ad-hoc identities require library-validation exceptions for the internal Electron runtime and native Sparkle loading. Apple-issued signatures retain the declared entitlements without adding that local exception.

The completed bundle and AgentShell receive strict recursive signature checks. Release also requires a certificate-based designated requirement. Signing uses local timestamps (`--timestamp=none`), matching local-build use. This command does not notarize, assess Gatekeeper acceptance, generate a signed Sparkle feed, or validate a public release. Follow the release/signing procedures separately before distribution.

## Runtime and authority boundaries

The native host passes the exact running control socket, current installation identity, and `development` or `release` channel to its owned child. Agent state lives in `AgentRuntime` below that native control directory, with a separate `Profile` subdirectory. Standalone Deckhand/T3 databases and native capture history retain their own storage. Provider authentication stays with the configured CLI; a separate agent data directory is not an authentication sandbox or a credential migration.

Parent-to-child route/activate/quit messages use the captured process's stdin. Child readiness, user Quit requests, and allowlisted native-tool requests use bounded stdout markers. Workspace routes are checked against the current native catalog; no arbitrary URLs, paths, or executable commands are accepted. Native Quit retains its running-work confirmation and waits for the captured child to close its backend pool. It does not terminate processes by name or discover unrelated PIDs.

Native-tool requests can open workspace/lane-map, history, preferences, capture, recording, annotation, or updates. The `workspace-setup` surface opens the existing discovery and project-check wizard without a selected workspace. `workspace-editor` requires an exact source workspace ID: no mode opens the definition editor, while `services`, `tasks`, or `workflows` opens the existing section and its editors. It refuses lane snapshots instead of editing an inferred owner. `execution-map` requires an exact workspace or lane ID and opens the full native task/workflow/process visualization. These tools reuse the existing native supervisor and editor sheets; closing the tool returns focus to the same agent-shell route. Capture modes and preference categories are explicitly validated. A recording opened with an exact workspace selects that workspace's native recording log scope. Actual capture and permission requests remain user actions. The backend socket UI method additionally requires the current installation identity and the private live-shell capability; that capability is not a renderer/provider credential. These UI methods do not add provider MCP permissions or general command execution.

Native Cinderdeck remains the only owner of workspace/lane service processes, ports, operational logs, runs, and native recordings. The agent runtime owns its threads, provider sessions, chat, diffs, and Chromium preview lifecycle. Shared-service aliases carry their actual owner workspace and optional canonical service target; a lane does not acquire a separate owner merely because it displays a shared service. Checkout writer admission coordinates agent activity, but is not operating-system isolation. Local provider sessions still require installed, authenticated CLIs and their advertised capabilities. This packaging command does not sign in providers, grant third-party access, or prove their live behavior.

## Maintaining T3 updates

Keep the runtime as its maintained T3-derived checkout. Reuse its adapters, contracts, WebSocket transport, Electron backend supervision, preview implementation, and artifact builder. Native-host and Cinderdeck feature modules contain the product integration; upstream changes still pass through the runtime's existing fork policy and patch audit. The native repository remains authoritative for Cinderdeck identity, permissions, operational resources, and whole-app updates. Updating the runtime alone does not update an installed unified app: rebuild, sign, and validate the complete outer bundle.

Compilation and signature verification do not prove the integrated product. Manually validate one main window, exact workspace/lane navigation, native tool entry points, provider selection and resumed conversations, preview/recording, shared-service ownership, relaunch, and cancellation/graceful quit. The Debug preview harness scopes operational files, capture output and processing, history database/thumbnails, recording metadata/audio and annotation sidecars to `CINDERDECK_STACKS_PREVIEW_ROOT`. Volatile fixture defaults enable saving and history while disabling clipboard copying. They do not redirect every persistent Debug preference write. Keep that distinction explicit when conducting manual checks.
