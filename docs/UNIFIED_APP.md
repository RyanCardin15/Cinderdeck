# Building Cinderdeck

Cinderdeck opens the T3 Code desktop interface. Its project picker groups conversations by folder. Native Cinderdeck owns the Dock identity, menu bar, capture permissions, History shortcut, and Sparkle updates. The embedded desktop process handles projects, agent providers, threads, terminals, and previews.

The native host starts the bundled Electron executable with a dedicated T3Runtime directory and Chromium profile. This keeps the previous AgentRuntime store available to earlier builds. The host sends window and shutdown commands through an inherited pipe. Closing the pipe also shuts down the child.

## Build and assemble

Clone the Cinderdeck repository normally. The maintained agent runtime source is included as tracked files under `agent-runtime/`, with full history and licenses. Use Xcode 26.2 or later and Rust/Cargo. The builder installs frozen dependencies and bootstraps the supported Node toolchain inside the clone when needed. It does not fetch a different harness revision.

```bash
./scripts/build-unified.sh \
  --output-dir /absolute/path/to/a/delivery-directory \
  --configuration Debug --arch arm64
```

The command runs the runtime's existing desktop artifact builder with `CINDERDECK_NATIVE_SHELL_BUILD=1`, targeting an unpacked macOS app. Node's directory and the runtime's `node_modules/.bin` lead that build's `PATH`. It builds native Cinderdeck at the same time, with the documented Xcode performance-inliner workaround and without an index store, then copies both products into a fresh staging directory and verifies the executable and bundle identifiers before signing.

Debug builds keep the three most recently used runtime builds in `.build/runtime-cache`. A build is reused only when everything that shapes it is unchanged: the runtime checkout's Git-visible files and ignored `.env` files, the Node, Rust and Swift toolchains, the architecture, the `DECKHAND_`, `VITE_`, `EXPO_PUBLIC_`, `CSC_`, `APPLE_`, `APP_VERSION` and `NODE_OPTIONS` environment, the build scripts, and the commit and dirty state embedded for About. A native-only change therefore skips the runtime build. A new commit rebuilds the runtime once. Release builds always rebuild it. Pass `--no-runtime-cache` or set `CINDERDECK_RUNTIME_CACHE=0` to force a rebuild.

To assemble already-built products for manual validation, supply either or both prebuilt apps:

```bash
./scripts/build-unified.sh \
  --output-dir /absolute/path/to/a/fresh-delivery-directory \
  --configuration Debug --arch arm64 \
  --native-app '/absolute/path/to/Cinderdeck Debug.app' \
  --runtime-app /absolute/path/to/Cinderdeck.app
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

`CINDERDECK_SIGNING_KEYCHAIN` selects an existing keychain; it defaults to the login keychain. The packager signs nested Mach-O code and bundles inside-out, first the runtime, then native helpers including Sparkle, then the outer app. It preserves existing helper entitlements, permits Electron's executable memory, and resolves the native entitlement bundle-ID variables for the selected configuration. Local/ad-hoc identities require library-validation exceptions for the internal Electron runtime and native Sparkle loading. Apple-issued signatures retain the declared entitlements without adding that local exception.

The completed bundle and its runtime receive strict recursive signature checks. Release also requires a certificate-based designated requirement. Local signing uses `--timestamp=none`. Distribution sets `CINDERDECK_SIGNING_TIMESTAMP=--timestamp` for Developer ID signatures, including nested runtime code. This command does not notarize, assess Gatekeeper acceptance, generate a signed Sparkle feed, or validate a public release. Follow the release/signing procedures separately before distribution.
