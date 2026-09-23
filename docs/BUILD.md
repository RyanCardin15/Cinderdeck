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

Select your own Apple Development or Developer ID signing identity. No upstream developer team, certificate, or private key is included.

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
