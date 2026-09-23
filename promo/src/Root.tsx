import "./index.css";
import { Composition } from "remotion";
import { Promo } from "./Composition";
export const RemotionRoot = () => (
  <Composition
    id="Cinderdeck"
    component={Promo}
    width={1920}
    height={1080}
    fps={30}
    durationInFrames={1440}
  />
);
