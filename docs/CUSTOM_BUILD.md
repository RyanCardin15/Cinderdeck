# Customized Snapzy build

Based on [duongductrong/Snapzy](https://github.com/duongductrong/Snapzy) version 1.32.3, commit `9f48e030`. The original BSD 3-Clause license and attribution are retained.

## Clipboard text history

Open **⌘⇧H → Clipboard text** to browse saved text. Enable collection in **Settings → History → Save copied text**, or use the panel's enable/resume control. Collection is opt-in on a fresh installation and captures new copies while Snapzy runs.

The compact panel shows text cards; the expanded view supports full-text previews, search, time filters, copying, and deletion. Text stays on the Mac for up to 30 days, with a maximum of 500 entries and 64 KiB per entry. See [History](HISTORY.md#clipboard-text) for details and sensitive-content exclusions.

## Build

Open `Snapzy.xcodeproj` in Xcode and select your own signing team, or supply your Apple Development identity and team through build settings. Do not commit signing certificates or private keys.

The Stacks custom build uses build number 194. With Xcode 26.3 / Swift 6.2.4, an upstream compiler crash in the performance inliner requires the following local Release build workaround:

```sh
export SNAPZY_SIGNING_IDENTITY='Apple Development: Your Name (IDENTITY_ID)'
export SNAPZY_TEAM_ID='YOUR_TEAM_ID'

xcodebuild -project Snapzy.xcodeproj -scheme Snapzy -configuration Release \
  -derivedDataPath .build/stacks-release \
  -destination 'platform=macOS,arch=arm64' \
  CODE_SIGN_IDENTITY="$SNAPZY_SIGNING_IDENTITY" \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="$SNAPZY_TEAM_ID" \
  CURRENT_PROJECT_VERSION=194 \
  'OTHER_SWIFT_FLAGS=$(inherited) -Xllvm -sil-disable-pass=PerfInliner' build
```

The app is produced at `.build/stacks-release/Build/Products/Release/Snapzy.app`. Back up the existing app before replacing `/Applications/Snapzy.app`. Keep the same signing identity for later builds; changing identity requires restoring Screen Recording and Accessibility permissions through System Settings.

Disable automatic update checks and downloads in Snapzy's General settings when using this customization. Installing an upstream release through Snapzy, Homebrew, or a manual download replaces the custom feature. Rebuild this repository to retain it.

## Verification

The clipboard-history delivery originally passed 113 targeted tests covering clipboard storage, capture history, database migrations, history layout and pinning, and configuration import/service behavior. Live checks verified collection, exact multiline/Unicode copying, search, and persistence across restarts.

The Stacks delivery passed **193 targeted tests** (including the existing regressions), a signed Release build, and live checks of project setup, branch/stash switching, logs, restart/reconnection, and shutdown.

## Configurable development stacks

Open **⌘⇧H → Stacks → Create stack**. Add any project folders and their start commands; Git is optional. A stack can combine different languages, separate repositories, multiple services in one repository, or tools with no repository at all. Use **⌘E** for service controls, branch management, logs, and activity. Definitions stay local in `~/.config/snapzy/stacks/`.

Stacks includes ordered startup, readiness checks, process-group shutdown, bounded crash retries, safe branch/stash workflows, Keychain references, and reconnection to services left running across app restarts. See [Stacks](STACKS.md) for setup and [the implementation record](STACKS_IMPLEMENTATION.md) for current verification evidence. Existing capture and clipboard functionality remains available in the same history panel.

Local history databases, preferences, configuration backups, and build artifacts are not part of this repository.
