# Building Cinderdeck

Cinderdeck supports macOS 13 or later. Building the current source requires Xcode 26.2 or later and its command-line tools. Dependencies resolve through Swift Package Manager.

## Development

Open `Cinderdeck.xcodeproj`, select the **Cinderdeck** scheme, and run. The Debug product is **Cinderdeck Debug.app**, with a separate bundle identifier (`com.ryancardin.cinderdeck.debug`). It does not import your production Snapzy data.

```sh
xcodebuild -project Cinderdeck.xcodeproj -scheme Cinderdeck \
  -configuration Debug -destination 'platform=macOS' \
  -derivedDataPath .build/development \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= build
open '.build/development/Build/Products/Debug/Cinderdeck Debug.app'
```

## Signed local installation

Use the local installer for builds you keep in `/Applications`. It creates a persistent **Cinderdeck Local Development** self-signed identity in your login keychain once, then reuses it on subsequent installs. No Apple Developer membership is needed.

```sh
# First install replacing an ad-hoc build: clear its stale TCC grants once.
./scripts/install-local.sh --reset-permissions
# Grant Screen Recording and Accessibility, then quit and reopen the app.

# Subsequent builds: preserve the identity and permissions.
./scripts/install-local.sh
```

The script builds Release, signs the app and Sparkle helpers, verifies the signature and certificate-based designated requirement, checks that the executable loads with its headless help command, then replaces `/Applications/Cinderdeck.app`. A previous installation is retained at the backup path printed by the script. `--build-only` validates a signed build without installing it; `--no-launch` skips opening the app after installation. macOS may ask you to authorize certificate trust or private-key access during first setup.

If you already use an Apple Development or Developer ID identity, keep it to avoid another identity change:

```sh
CINDERDECK_SIGNING_IDENTITY='Apple Development: Your Name (IDENTITY_ID)' \
  ./scripts/install-local.sh
```

The override accepts an exact identity name or its SHA-1 fingerprint from `security find-identity -v -p codesigning`. Ad-hoc signing is rejected. See [self-signed certificate setup](SELF_SIGNED_CERT.md) for the one-time repair and certificate lifecycle.

For a manual signed build, select your own Apple Development or Developer ID signing identity. No upstream developer team, certificate, or private key is included.

```sh
export CINDERDECK_SIGNING_IDENTITY='Apple Development: Your Name (IDENTITY_ID)'
export CINDERDECK_TEAM_ID='YOUR_TEAM_ID'
xcodebuild -project Cinderdeck.xcodeproj -scheme Cinderdeck \
  -configuration Release -destination 'platform=macOS' \
  -derivedDataPath .build/release \
  CODE_SIGN_IDENTITY="$CINDERDECK_SIGNING_IDENTITY" \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="$CINDERDECK_TEAM_ID" \
  'OTHER_SWIFT_FLAGS=$(inherited) -Xllvm -sil-disable-pass=PerfInliner' build
```

The final flag works around a Swift 6.2.4 / Xcode 26.3 performance-inliner compiler crash inherited from the source baseline. It keeps the Release optimization level; remove it only after verifying a newer compiler no longer needs it.

Quit the running app and back up any existing installation, then copy `.build/release/Build/Products/Release/Cinderdeck.app` to `/Applications`. Keep the same signing identity for subsequent local builds. The new Cinderdeck identity has its own macOS permission grants; see [migration](MIGRATION.md).

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
