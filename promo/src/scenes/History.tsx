import { interpolate, useCurrentFrame } from "remotion";
import { Canvas, Heading, Screen, Tag, DemoCursor } from "../visuals";
export const History = () => {
  const frame = useCurrentFrame();
  return (
    <Canvas chapter="01 / HISTORY">
      <Heading
        eyebrow="ALWAYS CLOSE"
        title="Pick up where you left off."
        detail="Captures, clipboard text, and workspaces in one History view."
      />
      <Screen
        src="history-compact"
        nativeWidth={920}
        nativeHeight={316}
        x={100}
        y={352}
        width={1720}
        height={591}
        delay={12}
      />
      <div
        style={{
          position: "absolute",
          left: 100,
          top: 975,
          display: "flex",
          gap: 18,
          opacity: interpolate(frame, [50, 70], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        <Tag active>Compact when you need it.</Tag>
        <Tag>One click to your workspace.</Tag>
      </div>
      <DemoCursor start={195} click={233} from={[1820, 930]} to={[1618, 414]} />
    </Canvas>
  );
};
