# Cinderdeck feature demo

The 48-second demo shows History, workspace services and repositories, ordered Workflows, saved run results, and GitHub pull requests. The full video has an original instrumental score; every feature is also explained onscreen, so it works muted.

- [Play or download the full MP4](../assets/cinderdeck-promo.mp4?raw=true)
- [Animated README version](../assets/cinderdeck-promo.gif)
- [Static poster](../assets/cinderdeck-promo-poster.png)
- In Cinderdeck: **Settings → About → Watch demo**. Playback is offline, has native controls and Replay, and stops when the demo window closes.

## Scenes and text description

| Time | Scene | What it shows |
| --- | --- | --- |
| 0:00–0:04 | Your work. Within reach. | Cinderdeck’s icon and development control deck for macOS. |
| 0:04–0:12 | Pick up where you left off. | The compact History panel, with capture and clipboard tabs, two workspace cards, running service indicators, and direct workspace access. |
| 0:12–0:19 | Your services. Your repositories. | Expanded History’s workspace details: terminal, stop and restart controls; API and web services; repository branches, Fetch and Pull. |
| 0:19–0:25 | One click. A clear sequence. | The Workflows tab. “Start preview” starts API then web; “Verify changes” runs Lint, Test, then Build. |
| 0:25–0:33 | Step by step. Output included. | A running workflow becomes a successful saved run, with per-step status, exit codes, elapsed time, and combined output. |
| 0:33–0:44 | Your pull requests, together. | The GitHub workspace, organization and repository filters, favorites, PR list, and detail inspector. A close-up highlights checks, review status, branch, and merge status. |
| 0:44–0:48 | Your development control deck. | Cinderdeck’s icon and repository address. |

Transitions overlap by 0.4 seconds. The native screens use explicitly fictional sample data. Workflow tasks execute harmless local sample commands; the displayed output is from those runs, not a claim about the application’s own test count. GitHub fixtures are offline and reject mutations. Pointer movements and timing are editorial overlays, not a continuous screen recording.

## Rebuilding

The editable Remotion project is in [`promo/`](../promo). Native screen artwork is generated from the actual SwiftUI/AppKit views by the opt-in `PromoSnapshotTests`, using temporary repositories, a temporary database, and isolated settings. The tests include compact/expanded History, light/dark appearance, long workspace names, a workspace without services, an empty search, and actual workflow execution.

Requirements: Node.js/npm, FFmpeg/ffprobe, and Xcode for refreshing native screens. Dependencies are pinned in `promo/package-lock.json`.

```sh
# Render with the checked-in native artwork and original score.
./scripts/render-promo.sh

# Refresh the native artwork first, then render.
./scripts/render-promo.sh --capture

# Edit the film interactively.
cd promo
npm ci
npm run dev
```

To regenerate the original instrumental score, use Python with NumPy and run `python3 promo/scripts/score.py`. The checked-in WAV allows normal builds without Python audio dependencies. All soundtrack notes are synthesized locally; there is no stock music or external audio license.

The render produces a 1920×1080, 30 fps H.264/AAC MP4 with its index at the beginning for fast playback; a looping 960×540, 10 fps GIF below 10 MB; and a full-resolution PNG poster. The Xcode project includes the MP4 directly from `assets/`, so the app and README share one source file. The GIF plays inline in README renderers supporting animated images; the adjacent MP4 link provides sound and controls. [GitHub’s media documentation](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files) lists GIF support and recommends H.264 for video compatibility.

`promo/scripts/validate.py` fully decodes both shipped formats, checks dimensions, codecs, duration, MP4 fast start, GIF loop metadata and size, and writes [`assets/cinderdeck-promo.json`](../assets/cinderdeck-promo.json) with SHA-256 checksums. It does not replace visual review: inspect the opening, each feature, both workflow states, both Git shots, transitions, and the ending at README size after changing the source.
