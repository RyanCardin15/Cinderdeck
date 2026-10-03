import {
  AbsoluteFill,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { Audio } from "@remotion/media";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { Opening } from "./scenes/Opening";
import { Workspaces } from "./scenes/Workspaces";
import { Lanes } from "./scenes/Lanes";
import { Agents } from "./scenes/Agents";
import { Workflows } from "./scenes/Workflows";
import { Recordings } from "./scenes/Recordings";
import { Handoff } from "./scenes/Handoff";
import { Closing } from "./scenes/Closing";
import { C, clamp } from "./design";

export const Showcase = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <TransitionSeries>
        <TransitionSeries.Sequence
          name="01 · Build in parallel"
          durationInFrames={192}
        >
          <Opening />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: 12 })}
        />
        <TransitionSeries.Sequence
          name="02 · Every moving part"
          durationInFrames={252}
        >
          <Workspaces />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: 12 })}
        />
        <TransitionSeries.Sequence
          name="03 · Parallel worktree lanes"
          durationInFrames={282}
        >
          <Lanes />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: 12 })}
        />
        <TransitionSeries.Sequence
          name="04 · Connected agents"
          durationInFrames={252}
        >
          <Agents />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: 12 })}
        />
        <TransitionSeries.Sequence
          name="05 · Repeatable workflows"
          durationInFrames={192}
        >
          <Workflows />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: 12 })}
        />
        <TransitionSeries.Sequence
          name="06 · Video and logs, together"
          durationInFrames={312}
        >
          <Recordings />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: 12 })}
        />
        <TransitionSeries.Sequence
          name="07 · Complete evidence"
          durationInFrames={222}
        >
          <Handoff />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition
          presentation={fade()}
          timing={linearTiming({ durationInFrames: 12 })}
        />
        <TransitionSeries.Sequence
          name="08 · Cinderdeck"
          durationInFrames={180}
        >
          <Closing />
        </TransitionSeries.Sequence>
      </TransitionSeries>
      <Audio src={staticFile("soundtrack.wav")} volume={1} />
      <div
        style={{
          position: "absolute",
          left: 0,
          bottom: 0,
          height: 3,
          width: interpolate(frame, [0, 1799], [0, 1920], clamp),
          background: "linear-gradient(90deg,#ff6b2c,#ffb66e)",
          opacity: 0.65,
        }}
      />
      <AbsoluteFill
        style={{
          background: "#090b0f",
          opacity: interpolate(frame, [0, 9, 1782, 1799], [1, 0, 0, 1], clamp),
          pointerEvents: "none",
        }}
      />
    </AbsoluteFill>
  );
};
