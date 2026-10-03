import { Composition, Folder } from "remotion";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./style.css";
import { Showcase } from "./Showcase";
import { Opening } from "./scenes/Opening";
import { Workspaces } from "./scenes/Workspaces";
import { Lanes } from "./scenes/Lanes";
import { Agents } from "./scenes/Agents";
import { Workflows } from "./scenes/Workflows";
import { Recordings } from "./scenes/Recordings";
import { Handoff } from "./scenes/Handoff";
import { Closing } from "./scenes/Closing";

export const RemotionRoot = () => (
  <>
    <Composition
      id="Cinderdeck-Showcase"
      component={Showcase}
      width={1920}
      height={1080}
      fps={30}
      durationInFrames={1800}
    />
    <Folder name="Scenes">
      <Composition
        id="Opening"
        component={Opening}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={192}
      />
      <Composition
        id="Workspaces"
        component={Workspaces}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={252}
      />
      <Composition
        id="Lanes"
        component={Lanes}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={282}
      />
      <Composition
        id="Agents"
        component={Agents}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={252}
      />
      <Composition
        id="Workflows"
        component={Workflows}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={192}
      />
      <Composition
        id="Recordings"
        component={Recordings}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={312}
      />
      <Composition
        id="Handoff"
        component={Handoff}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={222}
      />
      <Composition
        id="Closing"
        component={Closing}
        width={1920}
        height={1080}
        fps={30}
        durationInFrames={180}
      />
    </Folder>
  </>
);
