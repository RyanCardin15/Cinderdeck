import { useCurrentFrame, interpolate } from "remotion";
import { Canvas, Heading, Screen } from "../visuals";
export const Workspaces = () => {
  const frame = useCurrentFrame();
  return (
    <Canvas chapter="02 / WORKSPACES">
      <Heading
        eyebrow="ROOM TO WORK"
        title="Your services. Your repositories."
      />
      <Screen
        src="history-expanded"
        nativeWidth={1040}
        nativeHeight={680}
        crop={{ x: 246, y: 151, width: 776, height: 366 }}
        x={100}
        y={302}
        width={1720}
        height={698}
        delay={10}
      />
      <div
        style={{
          position: "absolute",
          left: 100,
          top: 243,
          fontSize: 30,
          color: "#b7b3ac",
          opacity: interpolate(frame, [18, 34], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        See what’s running. Open a terminal. Keep branches in view.
      </div>
    </Canvas>
  );
};
