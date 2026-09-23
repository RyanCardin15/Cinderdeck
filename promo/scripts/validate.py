"""Validate shipped formats and write their auditable media manifest."""
import hashlib
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
assets = root / "assets"
def probe(path):
    return json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)]))
manifest = {"duration_seconds": 48, "native_ui": "SwiftUI/AppKit renders from PromoSnapshotTests", "sample_data": True, "files": {}}
for name, codec, width, height in [("cinderdeck-promo.mp4", "h264", 1920, 1080), ("cinderdeck-promo.gif", "gif", 960, 540)]:
    path = assets / name
    data = probe(path)
    video = next(s for s in data["streams"] if s["codec_type"] == "video")
    assert (video["codec_name"], video["width"], video["height"]) == (codec, width, height), data
    assert abs(float(data["format"]["duration"]) - 48) < .2, data
    if codec == "h264":
        assert video["pix_fmt"] == "yuv420p"
        assert video["r_frame_rate"] == "30/1"
        assert any(s["codec_name"] == "aac" for s in data["streams"])
        blob = path.read_bytes()
        assert blob.index(b"moov") < blob.index(b"mdat"), "MP4 must support fast-start playback"
    else:
        assert path.stat().st_size < 10_000_000, "Keep the inline README GIF below 10 MB"
        assert b"NETSCAPE2.0" in path.read_bytes(), "GIF must loop"
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "null", "-"], check=True)
    manifest["files"][name] = {"bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "width": width, "height": height, "codec": codec}
poster = assets / "cinderdeck-promo-poster.png"
assert probe(poster)["streams"][0]["width"] == 1920
(assets / "cinderdeck-promo.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps(manifest, indent=2))
