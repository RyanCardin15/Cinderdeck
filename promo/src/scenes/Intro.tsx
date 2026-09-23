import {
  CanvasImage,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { Canvas, Tag } from "../visuals";
export const Intro = () => {
  const frame = useCurrentFrame();
  return (
    <Canvas>
      <Interactive.Div
        name="App icon"
        style={{
          position: "absolute",
          left: 1340,
          top: 240,
          width: 400,
          height: 400,
          opacity: interpolate(frame, [0, 22], [1, 1], {
            extrapolateRight: "clamp",
          }),
          scale: interpolate(frame, [0, 40], [0.9, 1], {
            extrapolateRight: "clamp",
          }),
        }}
      >
        <CanvasImage
          src={staticFile("icon.png")}
          style={{ width: 400, height: 400 }}
        />
      </Interactive.Div>
      <Interactive.Div
        name="Opening promise"
        style={{
          position: "absolute",
          left: 100,
          top: 240,
          fontSize: 144,
          fontWeight: 700,
          lineHeight: 1.02,
          letterSpacing: -8,
          opacity: interpolate(frame, [0, 18], [1, 1], {
            extrapolateRight: "clamp",
          }),
        }}
      >
        Your work.
        <br />
        <span style={{ color: "#ff8a50" }}>Within reach.</span>
      </Interactive.Div>
      <Interactive.Div
        name="Product promise"
        style={{
          position: "absolute",
          left: 108,
          top: 625,
          fontSize: 38,
          color: "#c7c1b8",
          opacity: interpolate(frame, [18, 36], [1, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        Your development control deck for macOS.
      </Interactive.Div>
      <div
        style={{
          position: "absolute",
          left: 108,
          top: 790,
          display: "flex",
          gap: 18,
        }}
      >
        <Tag>History</Tag>
        <Tag>Workflows</Tag>
        <Tag>Git</Tag>
      </div>
    </Canvas>
  );
};
