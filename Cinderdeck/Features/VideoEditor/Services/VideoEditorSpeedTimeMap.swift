//
//  SpeedTimeMap.swift
//  Cinderdeck
//
//  Pure time-math for per-segment speed (timelapse). Single source of truth reused by
//  export, preview, playhead, thumbnails, and GIF generation.
//

import CoreMedia
import Foundation

/// Maps time between the ORIGINAL (trim-relative) timeline and the SCALED timeline produced
/// by applying per-segment playback rates.
///
/// All math is in trim-relative seconds: `t = 0` corresponds to `trimStart`. Speed segments
/// are clipped to the trim window and the gaps between them are filled with `rate == 1` spans
/// so the resulting span list always tiles `[0, originalDuration]` with no holes.
///
/// `scaleTimeRange` semantics: a span of original duration `d` at rate `r` becomes `d / r`
/// on the scaled timeline (`r > 1` shortens → faster, `r < 1` lengthens → slower).
struct SpeedTimeMap: Equatable {
  /// A contiguous span on the ORIGINAL trim-relative timeline with a single playback rate.
  struct Span: Equatable {
    let origStart: TimeInterval
    let origDuration: TimeInterval
    let rate: Double

    var origEnd: TimeInterval { origStart + origDuration }
    var scaledDuration: TimeInterval { origDuration / rate }
  }

  /// Contiguous, sorted spans covering `[0, originalDuration]` (1x gaps included).
  let spans: [Span]
  /// Trimmed (original) duration in seconds.
  let originalDuration: TimeInterval
  /// Resulting duration after scaling = Σ span.scaledDuration.
  let scaledDuration: TimeInterval

  /// True when no enabled non-1x speed segment affects the timeline (identity map).
  var isIdentity: Bool {
    spans.allSatisfy { $0.rate == 1.0 }
  }

  // MARK: - Build

  /// Build from absolute speed segments + the trim window (absolute seconds).
  init(speedSegments: [SpeedSegment], trimStart: TimeInterval, trimEnd: TimeInterval) {
    let originalDuration = max(0, trimEnd - trimStart)
    self.originalDuration = originalDuration

    // 1. enabled, non-1x, clamped to trim window, converted to trim-relative, sorted.
    let effective: [(start: TimeInterval, end: TimeInterval, rate: Double)] = speedSegments
      .filter { $0.isEnabled && $0.rate != 1.0 }
      .map { seg -> (TimeInterval, TimeInterval, Double) in
        let s = max(trimStart, min(seg.startTime, trimEnd))
        let e = max(trimStart, min(seg.endTime, trimEnd))
        return (s - trimStart, e - trimStart, SpeedSegment.clampRate(seg.rate))
      }
      .filter { $0.1 - $0.0 > 0.0001 }
      .sorted { $0.0 < $1.0 }

    // 2. tile [0, originalDuration]; clamp defensively against any residual overlap.
    var spans: [Span] = []
    var cursor: TimeInterval = 0
    for seg in effective {
      let start = max(seg.start, cursor) // defensive: skip already-covered region
      if start >= seg.end { continue }
      if start > cursor + 0.0001 {
        spans.append(Span(origStart: cursor, origDuration: start - cursor, rate: 1.0)) // 1x gap
      }
      spans.append(Span(origStart: start, origDuration: seg.end - start, rate: seg.rate))
      cursor = seg.end
    }
    if cursor < originalDuration - 0.0001 {
      spans.append(Span(origStart: cursor, origDuration: originalDuration - cursor, rate: 1.0))
    }
    // Empty timeline (no trim / zero duration) → single trivial span keeps the map total.
    if spans.isEmpty && originalDuration > 0 {
      spans.append(Span(origStart: 0, origDuration: originalDuration, rate: 1.0))
    }

    self.spans = spans
    self.scaledDuration = spans.reduce(0) { $0 + $1.scaledDuration }
  }

  // MARK: - Mapping

  /// ORIGINAL trim-relative seconds → SCALED seconds.
  /// Used by export (instruction rebuild, zoom/auto-focus remap) and forward playhead math.
  func toScaled(_ original: TimeInterval) -> TimeInterval {
    // Clamp out-of-range input to the timeline start (scaled 0 always maps from original 0,
    // regardless of the first span's rate).
    guard original > 0 else { return 0 }
    var acc: TimeInterval = 0
    for span in spans {
      if original < span.origEnd {
        let into = max(0, original - span.origStart)
        return acc + into / span.rate
      }
      acc += span.scaledDuration
    }
    return scaledDuration // clamp past-end
  }

  /// SCALED seconds → ORIGINAL trim-relative seconds.
  /// Used by playhead UI, scrubbing, and thumbnail sync (preview runs on the scaled timeline,
  /// the timeline UI displays original time).
  func toOriginal(_ scaled: TimeInterval) -> TimeInterval {
    // Clamp out-of-range input to the timeline start (guards against negative scaled times).
    guard scaled > 0 else { return 0 }
    var accScaled: TimeInterval = 0
    for span in spans {
      let spanScaled = span.scaledDuration
      if scaled < accScaled + spanScaled {
        let into = scaled - accScaled
        return span.origStart + into * span.rate
      }
      accScaled += spanScaled
    }
    return originalDuration // clamp past-end
  }

  /// Playback rate active at an ORIGINAL trim-relative time (GIF effective-fps, UI readout).
  func rate(atOriginal t: TimeInterval) -> Double {
    for span in spans where t >= span.origStart && t < span.origEnd {
      return span.rate
    }
    return spans.last?.rate ?? 1.0
  }

  // MARK: - CMTime convenience

  /// Scaled duration as `CMTime` (timescale 600, matching the export pipeline).
  func scaledCMDuration() -> CMTime {
    CMTime(seconds: scaledDuration, preferredTimescale: 600)
  }
}
