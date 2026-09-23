import { Canvas, Heading, Screen, Tag, DemoCursor } from "../visuals";
export const Workflows = () => (
  <Canvas chapter="03 / WORKFLOWS">
    <Heading
      eyebrow="FROM COMMANDS TO A ROUTINE"
      title="One click. A clear sequence."
      detail="Reusable tasks and service actions, in the order you choose."
    />
    <Screen
      src="workflows"
      nativeWidth={1160}
      nativeHeight={720}
      crop={{ x: 337, y: 81, width: 804, height: 277 }}
      x={100}
      y={376}
      width={1720}
      height={594}
      delay={12}
    />
    <div
      style={{
        position: "absolute",
        left: 100,
        top: 978,
        display: "flex",
        gap: 18,
      }}
    >
      <Tag>Lint</Tag>
      <Tag>→ Test</Tag>
      <Tag>→ Build</Tag>
    </div>
    <DemoCursor start={130} click={173} from={[1800, 970]} to={[1640, 861]} />
  </Canvas>
);
