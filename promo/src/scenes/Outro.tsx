import { CanvasImage, staticFile } from "remotion";
import { Canvas, Tag } from "../visuals";
export const Outro = () => (
  <Canvas>
    <CanvasImage
      src={staticFile("icon.png")}
      style={{
        position: "absolute",
        left: 820,
        top: 125,
        width: 280,
        height: 280,
      }}
    />
    <div
      style={{
        position: "absolute",
        top: 450,
        width: "100%",
        textAlign: "center",
        fontSize: 112,
        letterSpacing: -5,
        fontWeight: 700,
      }}
    >
      Cinderdeck
    </div>
    <div
      style={{
        position: "absolute",
        top: 605,
        width: "100%",
        textAlign: "center",
        fontSize: 46,
        color: "#d4cec5",
      }}
    >
      Your development control deck.
    </div>
    <div
      style={{
        position: "absolute",
        top: 730,
        width: "100%",
        display: "flex",
        gap: 20,
        justifyContent: "center",
      }}
    >
      <Tag>History</Tag>
      <Tag>Workflows</Tag>
      <Tag>Git</Tag>
    </div>
    <div
      style={{
        position: "absolute",
        top: 927,
        width: "100%",
        textAlign: "center",
        fontSize: 30,
        color: "#ff9c69",
      }}
    >
      github.com/RyanCardin15/Cinderdeck
    </div>
  </Canvas>
);
