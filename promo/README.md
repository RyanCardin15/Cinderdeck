# Cinderdeck showcase

A 60-second, 1920 × 1080, 30 fps product film with an original stereo instrumental score. The editable master is `Cinderdeck-Showcase`; all eight scenes also have their own connected Studio timelines.

## Watch or edit

From this folder:

```sh
npm ci
npm run dev
```

Open the exact URL printed by Studio (normally `http://localhost:3417/Cinderdeck-Showcase`). The server runs without opening the system browser. Select the main composition and press Space to play; expand **Scenes** to edit one chapter. The scene names, headline groups, and major visual layers are named in the timeline. Text and fine interface details live in `src/scenes/`; shared visual components live in `src/design.tsx`.

## Export

```sh
npm run lint
npm run render
npm run render:poster
npm run render:gif
```

The MP4 is written to `out/cinderdeck-showcase.mp4` with H.264, CRF 17, yuv420p, and 320 kb/s AAC. The poster is `out/cinderdeck-showcase-poster.png`. Remotion downloads its compatible Chrome Headless Shell on first render; use that renderer, since the system Chrome produced repeated tiles in initial frame checks.

The repository's distributable assets are:

- `../assets/cinderdeck-promo.mp4` — full film, with sound.
- `../assets/cinderdeck-promo-poster.png` — opening hero frame.
- `../assets/cinderdeck-promo.gif` — silent, condensed 16-second overview.

The root README plays the full film through a GitHub video attachment and offers the versioned MP4 as a download. Keep playback on the attachment: linking to the repository's MP4 file opens GitHub's file viewer, which can fail in GitHub Mobile.

### Publish a replacement video

After rendering and updating the distributable assets, upload the new MP4 to the showcase pull request. A current GitHub CLI with attachment support can do this from this folder:

```sh
gh pr edit <pull-request-number> --attach ../assets/cinderdeck-promo.mp4
```

Alternatively, attach the video in GitHub's Markdown editor. Copy the resulting `https://github.com/user-attachments/assets/…` URL into the root README as a bare URL in its own paragraph so GitHub renders a native video player. Use the permanent attachment URL, not its expiring redirect. Verify the rendered player loads, plays with audio, and seeks before merging; check the GitHub phone app when available. See [GitHub's attachment instructions](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli).

## Story and motion

| Time        | Scene                               | What moves and what it communicates                                                                                       |
| ----------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 00:00–00:06 | Build in parallel. Stay in control. | The icon and feature labels assemble inside a moving connection diagram.                                                  |
| 00:06–00:14 | Workspaces                          | A cursor starts the environment; dependencies become ready in sequence, then live output appears.                         |
| 00:14–00:23 | Parallel lanes                      | Three branch bands assemble with separate ports, visible agent ownership, and a shared database rail.                     |
| 00:23–00:31 | MCP connectivity                    | Codex, Claude Code, Cursor, and VS Code Copilot connect to the local MCP hub; real tool names and argument shapes appear. |
| 00:31–00:37 | Tasks and workflows                 | Lint, API readiness, tests, and build advance in order, followed by a saved run result.                                   |
| 00:37–00:47 | Recordings with logs                | Video time drives visible output and markers; clicking the first error seeks back to 00:08.420.                           |
| 00:47–00:54 | Evidence handoff                    | The browser recording expands into video, timestamped logs, frames, Git diffs, and readable/structured summaries.         |
| 00:54–01:00 | Closing                             | Icon, wordmark, repository CTA, and supporting capture/PR/clipboard capabilities resolve into the end card.               |

All motion is deterministic and driven by Remotion frames. The composition accounts for seven 12-frame transitions and ends at exactly 1,800 frames. There is no narration; the message works with sound muted.

## Product accuracy

This is a designed motion showcase with illustrative interface reconstructions, not a recording of a live customer workspace. Orbit, its projects, branch names, ports, log entries, timings, and test outcomes are fictional demonstration data. Timings are not performance claims. Client icons are generic symbols rather than third-party brand marks.

Capabilities were checked against `main` at `da3f6087`:

- `../docs/WORKSPACES.md` — services, tasks, workflows, lane map, saved runs, agent leases.
- `../docs/LANES_VALIDATION.md` and `../Cinderdeck/Features/Stacks/Components/StackLanesView.swift` — new/adopted worktrees, per-lane services, ports, and shared resources.
- `../Cinderdeck/Services/Stacks/Agents/CinderdeckMCPServer.swift` — `list_workspaces`, `create_lane` with `branch`, `run_workspace_workflow`, and `repro_frame` argument shapes.
- `../docs/REPROS.md` — workspace selection, markers, error seeking, Git context, headless Chromium, and export bundle contents.
- `../docs/BRANDING.md` — existing icon, charcoal palette, and ember accent.

## Soundtrack

`scripts/make-soundtrack.mjs` synthesizes an original 120 BPM score from oscillators and seeded noise. It includes warm pads, plucked arpeggios, a restrained pulse, stereo delay, scene-change sweeps, and small interaction cues. It uses no downloaded music or samples.

Regenerate with Node and FFmpeg:

```sh
npm run audio:generate
ffmpeg -y -i public/soundtrack-raw.wav \
  -af 'loudnorm=I=-17:TP=-1.5:LRA=8' -ar 48000 public/soundtrack.wav
```

The normalized WAV is versioned so normal preview/render does not require FFmpeg. The intermediate raw WAV is ignored. The original delivered WAV measured approximately −16.4 LUFS integrated, with −3.2 dBFS true peak. Fonts are self-hosted through pinned Fontsource packages, and icons come from Lucide. No network media or font requests are needed during playback.

## Validation

Run TypeScript and ESLint with `npm run lint`. Review representative rendered frames from every scene, as well as transitions and the error-seek moment, before distributing a new export. Inspect final duration, stream metadata, and decode errors with FFprobe/FFmpeg. A successful source build alone is not a visual review.

Remotion's own [license terms](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md) apply to the tooling. Fontsource and Lucide packages retain their included licenses.
