import { Audio } from "@remotion/media";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { staticFile } from "remotion";
import { Intro } from "./scenes/Intro";
import { History } from "./scenes/History";
import { Workspaces } from "./scenes/Workspaces";
import { Workflows } from "./scenes/Workflows";
import { Runs } from "./scenes/Runs";
import { Git } from "./scenes/Git";
import { Outro } from "./scenes/Outro";
export const Promo = () => (
  <>
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={120}>
        <Intro />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: 12 })}
      />
      <TransitionSeries.Sequence durationInFrames={252}>
        <History />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: 12 })}
      />
      <TransitionSeries.Sequence durationInFrames={222}>
        <Workspaces />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: 12 })}
      />
      <TransitionSeries.Sequence durationInFrames={192}>
        <Workflows />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: 12 })}
      />
      <TransitionSeries.Sequence durationInFrames={252}>
        <Runs />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: 12 })}
      />
      <TransitionSeries.Sequence durationInFrames={354}>
        <Git />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: 12 })}
      />
      <TransitionSeries.Sequence durationInFrames={120}>
        <Outro />
      </TransitionSeries.Sequence>
    </TransitionSeries>
    <Audio src={staticFile("score.wav")} />
  </>
);
