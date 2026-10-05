# Building Cinderdeck

Cinderdeck supports macOS 13 or later. Building requires Xcode 26.2 or later, its command-line tools, Rust/Cargo, and internet access for the first build. Swift packages and locked harness dependencies are installed automatically. The builder uses Node 24.13.1+ from your PATH, or downloads the pinned Node 24 toolchain into this clone's `.build/toolchains` directory. It uses the harness's pinned pnpm version.

## Development

Clone just this repository, then run from wherever you downloaded it:

```sh
git clone https://github.com/RyanCardin15/Cinderdeck.git
cd Cinderdeck
# If Rust is missing: brew install rust
./scripts/build_and_run.sh
```

This builds and launches one **Cinderdeck Debug.app**, including its agent harness. No sibling checkout, submodule initialization, absolute source path, or separate harness launch is needed. Debug uses `com.ryancardin.cinderdeck.debug` and does not import production Snapzy data. Provider CLIs must still be installed and authenticated to run their agents.

`--logs`, `--telemetry`, `--debug`, `--verify`, `--configuration`, `--derived-data` and `--clean` remain available; see `./scripts/build_and_run.sh --help`. The script prints the complete app path. Each delivery goes into a fresh output directory, while the native build cache is reused. It leaves other running app instances alone.

For an artifact without launching:

```sh
./scripts/build-unified.sh --output-dir "$PWD/.build/delivery" --configuration Debug
```

Use a fresh output directory for each delivery. Xcode's direct Run builds the native host only, which is useful for native service tests. Use the whole-app commands above for the complete product. See [unified app details](UNIFIED_APP.md).

## Signed local installation

Use the local installer for builds you keep in `/Applications`. It creates a persistent **Cinderdeck Local Development** self-signed identity in your login keychain once, then reuses it on subsequent installs. No Apple Developer membership is needed.

```sh
# First install replacing an ad-hoc build: clear its stale TCC grants once.
./scripts/install-local.sh --reset-permissions
# Grant Screen Recording and Accessibility, then quit and reopen the app.

# Subsequent builds: preserve the identity and permissions.
./scripts/install-local.sh
```

The script builds the complete Release app, signs the embedded harness, app and Sparkle helpers, verifies the signature and certificate-based designated requirement, checks that the executable loads with its headless help command, then replaces `/Applications/Cinderdeck.app`. A previous installation is retained as a verified ZIP archive at the backup path printed by the script. Keeping backups as archives prevents macOS from registering them as extra applications or labeling permission entries “previous.” The build product is unregistered from LaunchServices so the installed copy handles normal launches and links. `--build-only` validates a signed build without installing it; `--no-launch` skips opening the app after installation. macOS may ask you to authorize certificate trust or private-key access during first setup.

If you already use an Apple Development or Developer ID identity, keep it to avoid another identity change:

```sh
CINDERDECK_SIGNING_IDENTITY='Apple Development: Your Name (IDENTITY_ID)' \
  ./scripts/install-local.sh
```

The override accepts an exact identity name or its SHA-1 fingerprint from `security find-identity -v -p codesigning`. Ad-hoc signing is rejected. See [self-signed certificate setup](SELF_SIGNED_CERT.md) for the one-time repair and certificate lifecycle.

For a manual signed artifact without installation, use the same whole-app packager:

```sh
./scripts/build-unified.sh --configuration Release \
  --output-dir "$PWD/.build/release-delivery" \
  --signing-identity 'Apple Development: Your Name (IDENTITY_ID)'
```

The packager includes the Swift performance-inliner workaround needed by Xcode 26.3. Keep the same signing identity for subsequent local builds; see [migration](MIGRATION.md).

## Tests

```sh
scripts/run-tests.sh
# Focused service, process, configuration, and database coverage:
scripts/stacks-verify.sh test
```

Use `-only-testing:CinderdeckTests/TestClassName` with `scripts/run-tests.sh` to select a suite. `CinderdeckMigrationTests` covers database import with WAL records, preserving source and destination data, retry after failure, legacy links, and update isolation.

## Artwork

`assets/cinderdeck-icon.png` is the master icon. The asset catalog contains every macOS size. To regenerate them using the existing asset script, install ImageMagick and run `scripts/generate-app-icon-assets.sh`. The menu-bar mark is drawn natively by `MenuBarIconRenderer` so it follows macOS light/dark appearance. See [branding](BRANDING.md) for provenance.

## Distribution

See [RELEASES.md](RELEASES.md) for signing, notarization, Sparkle setup, DMG packaging, and cask generation. A local Apple Development build is not a notarized public release.
