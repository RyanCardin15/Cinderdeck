# Development

Set up Cinderdeck for local development and run it from source.

## Prerequisites

- macOS 13.0+
- Xcode 26.2+
- Command Line Tools: `xcode-select --install`

## Clone the repository

```bash
git clone https://github.com/RyanCardin15/Cinderdeck.git
cd Cinderdeck
```

## Open in Xcode

```bash
open Cinderdeck.xcodeproj
```

Build and run with `Cmd+R`.

## Build from the terminal

```bash
xcodebuild -project Cinderdeck.xcodeproj -scheme Cinderdeck -configuration Debug build
```

Output: `~/Library/Developer/Xcode/DerivedData/Cinderdeck-*/Build/Products/Debug/Cinderdeck Debug.app`

## Run the local debug app

```bash
./scripts/build_and_run.sh
```

The script builds the Debug app at
`.build/xcode-derived-data/Build/Products/Debug/Cinderdeck Debug.app`. This local
build uses app name `Cinderdeck Debug` and bundle ID `com.ryancardin.cinderdeck.debug`
so macOS Privacy permissions stay separate from the published `Cinderdeck` app.

Reset local Debug permissions with:

```bash
tccutil reset ScreenCapture com.ryancardin.cinderdeck.debug
tccutil reset Microphone com.ryancardin.cinderdeck.debug
tccutil reset Accessibility com.ryancardin.cinderdeck.debug
```

If System Settings still shows the old `Cinderdeck` label for the debug bundle,
quit System Settings, run the reset commands above, launch `Cinderdeck Debug` again,
then grant permissions from the fresh prompt/list entry.

## Run tests

Unit tests live in `CinderdeckTests/`, a peer folder of `Cinderdeck/`. Keep XCTest files
there so they belong to the `CinderdeckTests` target instead of the app target.

```bash
xcodebuild test -project Cinderdeck.xcodeproj -scheme Cinderdeck -configuration Debug
```

The shared `Cinderdeck` scheme uses `Cinderdeck.xctestplan`, which includes the
`CinderdeckTests` target for command-line runs and Xcode editor gutter test runs.

Tests that require real macOS privacy permissions or hardware devices are kept
out of the default flow. To run the real microphone smoke test locally, grant
Microphone access first, then run:

```bash
CINDERDECK_RUN_MICROPHONE_INTEGRATION=1 xcodebuild test -project Cinderdeck.xcodeproj -scheme Cinderdeck -configuration Debug -only-testing:CinderdeckTests/MicrophoneAudioCapturerTests/testMicrophoneAudioCapturerStartStopRealMicrophoneIntegration
```

## Render SwiftUI components to a PNG

`PermissionRowSnapshotRenderTests` renders the real `PermissionRow` states through
`ImageRenderer` and writes `/tmp/cinderdeck-permission-rows.png`. It is useful for checking
layout of an onboarding component without launching the app (handy when a debug instance is
already running and a second one would contend for global shortcuts).

Note `xcodebuild` does not forward shell environment variables to the test process — the
`TEST_RUNNER_` prefix is required:

```bash
TEST_RUNNER_CINDERDECK_RENDER_PERMISSION_ROWS=1 xcodebuild test -project Cinderdeck.xcodeproj -scheme Cinderdeck -configuration Debug -only-testing:CinderdeckTests/PermissionRowSnapshotRenderTests
```

It is skipped without that variable, and it asserts nothing — it is a visual-inspection
tool, not a regression test. Colors are not faithful: `ImageRenderer` does not resolve the
dynamic `NSColor`s in `VSDesignSystem.Colors` to their dark-appearance values, so treat the
output as a geometry and layout check only.

## Related docs

- For archive, export, and DMG packaging commands, see [BUILD.md](BUILD.md).
- For release and appcast workflow, see [RELEASES.md](RELEASES.md).
