import { interpolate, useCurrentFrame } from "remotion";
import { Canvas, Screen, Tag } from "../visuals";
export const Runs = () => {
  const frame = useCurrentFrame();
  return (
    <Canvas chapter="04 / RUN RESULTS">
      <div style={{ position: "absolute", left: 100, top: 230, width: 530 }}>
        <div
          style={{
            fontSize: 22,
            color: "#ff8a50",
            fontWeight: 700,
            letterSpacing: 3,
            marginBottom: 24,
          }}
        >
          KNOW HOW IT WENT
        </div>
        <div
          style={{
            fontSize: 88,
            fontWeight: 700,
            lineHeight: 1.08,
            letterSpacing: -4,
          }}
        >
          Step by step.
          <br />
          Output
          <br />
          included.
        </div>
        <div
          style={{
            fontSize: 32,
            color: "#bbb5ad",
            lineHeight: 1.5,
            marginTop: 38,
          }}
        >
          Follow progress, inspect exit codes, and revisit saved runs.
        </div>
        <div style={{ marginTop: 45 }}>
          <Tag active>{frame < 132 ? "Running →" : "✓ Succeeded"}</Tag>
        </div>
      </div>
      <Screen
        src="workflow-running"
        nativeWidth={1160}
        nativeHeight={720}
        crop={{ x: 590, y: 154, width: 550, height: 370 }}
        x={690}
        y={235}
        width={1130}
        height={760}
        delay={12}
      />
      <div
        style={{
          opacity: interpolate(frame, [120, 137], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        <Screen
          src="workflow-complete"
          nativeWidth={1160}
          nativeHeight={720}
          crop={{ x: 590, y: 154, width: 550, height: 370 }}
          x={690}
          y={235}
          width={1130}
          height={760}
        />
      </div>
    </Canvas>
  );
};
