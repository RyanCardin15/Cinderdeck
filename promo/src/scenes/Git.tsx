import { interpolate, useCurrentFrame } from "remotion";
import { Canvas, Heading, Screen } from "../visuals";
export const Git = () => {
  const frame = useCurrentFrame();
  return (
    <Canvas chapter="05 / GIT & PULL REQUESTS">
      <div
        style={{
          opacity: interpolate(frame, [130, 148], [1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        <Heading
          eyebrow="SEE THE WHOLE CHANGE"
          title="Your pull requests, together."
        />
        <Screen
          src="git-overview"
          nativeWidth={1280}
          nativeHeight={760}
          x={100}
          y={270}
          width={1720}
          height={755}
          delay={10}
        />
      </div>
      <div
        style={{
          opacity: interpolate(frame, [136, 154], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        <div style={{ position: "absolute", left: 100, top: 242, width: 680 }}>
          <div
            style={{
              color: "#ff8a50",
              fontSize: 22,
              fontWeight: 700,
              letterSpacing: 3,
              marginBottom: 28,
            }}
          >
            REVIEW WITH CONTEXT
          </div>
          <div
            style={{
              fontSize: 88,
              fontWeight: 700,
              letterSpacing: -4,
              lineHeight: 1.08,
            }}
          >
            The signals
            <br />
            behind
            <br />
            every change.
          </div>
          <div
            style={{
              marginTop: 42,
              fontSize: 34,
              color: "#c6c0b8",
              lineHeight: 1.9,
            }}
          >
            Checks and review status.
            <br />
            Branches and changed files.
            <br />
            Repositories and saved views.
          </div>
        </div>
        <Screen
          src="git-overview"
          nativeWidth={1280}
          nativeHeight={760}
          crop={{ x: 887, y: 262, width: 382, height: 260 }}
          x={875}
          y={280}
          width={950}
          height={647}
        />
      </div>
    </Canvas>
  );
};
