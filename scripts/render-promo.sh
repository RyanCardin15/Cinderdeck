#!/bin/bash
# Rebuild the native-screen promo and all public formats from checked-in sources.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"
mkdir -p .build/promo
if [[ "${1:-}" == "--capture" ]]; then
  touch .build/promo/capture-native
  trap 'rm -f "$REPO_ROOT/.build/promo/capture-native"' EXIT
  xcodebuild -project Cinderdeck.xcodeproj -scheme Cinderdeck \
    -configuration Debug -destination 'platform=macOS' \
    -derivedDataPath .build/promo-build -parallel-testing-enabled NO \
    CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= \
    -only-testing:CinderdeckTests/PromoSnapshotTests test \
    > .build/promo/capture.log 2>&1
  rm -f .build/promo/capture-native
fi
for tool in node npm ffmpeg ffprobe; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done
if [[ ! -d promo/node_modules ]]; then npm ci --prefix promo --no-audit --no-fund; fi
# The original score and native 2x PNG renders are checked in. Re-synthesize
# optional audio with: python3 promo/scripts/score.py (requires NumPy).
(cd promo && npm run lint && npx remotion render Cinderdeck ../.build/promo/master.mp4 \
  --codec=h264 --crf=18 --pixel-format=yuv420p --concurrency=4)
ffmpeg -hide_banner -loglevel error -y -i .build/promo/master.mp4 \
  -c:v copy -c:a aac -b:a 192k -af 'loudnorm=I=-20:TP=-2:LRA=7' \
  -movflags +faststart -metadata title='Cinderdeck — History, Workflows, and Git' \
  assets/cinderdeck-promo.mp4
ffmpeg -hide_banner -loglevel error -y -i assets/cinderdeck-promo.mp4 \
  -filter_complex 'fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle' \
  -loop 0 assets/cinderdeck-promo.gif
ffmpeg -hide_banner -loglevel error -y -ss 7.5 -i assets/cinderdeck-promo.mp4 \
  -frames:v 1 -update 1 assets/cinderdeck-promo-poster.png
python3 promo/scripts/validate.py
