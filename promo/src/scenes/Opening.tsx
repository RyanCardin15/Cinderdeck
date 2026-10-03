import {
  Img,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { GitBranch, Layers, Radio, Video } from "lucide-react";
import { C, clamp, ease, enter, FlowPath, mono, SceneFrame } from "../design";

export const Opening = () => {
  const f = useCurrentFrame();
  return (
    <SceneFrame number="01" label="DEVELOPMENT, CONNECTED">
      <svg
        width="1920"
        height="1080"
        style={{ position: "absolute", opacity: 0.5 }}
      >
        <FlowPath d="M-50 340 H950 Q1060 340 1135 420 L1380 650" delay={0} />
        <FlowPath
          d="M-50 790 H860 Q1010 790 1090 735 L1380 650"
          color={C.blue}
          delay={9}
        />
        <FlowPath
          d="M1990 240 H1600 Q1480 240 1440 440 L1380 650"
          color={C.green}
          delay={18}
        />
      </svg>
      <Interactive.Div
        name="Opening promise"
        style={{
          position: "absolute",
          left: 96,
          top: 233,
          opacity: interpolate(f, [5, 28], [0, 1], clamp),
          translate: interpolate(f, [5, 43], ["0px 55px", "0px 0px"], {
            ...clamp,
            easing: ease,
          }),
        }}
      >
        <div
          style={{
            fontFamily: mono,
            color: C.orange,
            fontSize: 18,
            letterSpacing: 5,
            marginBottom: 37,
          }}
        >
          YOUR DEVELOPMENT CONTROL DECK
        </div>
        <div
          style={{
            fontSize: 116,
            fontWeight: 650,
            letterSpacing: -7,
            lineHeight: 1.03,
          }}
        >
          Build in parallel.
          <br />
          <span style={{ color: C.orange }}>Stay in control.</span>
        </div>
        <div
          style={{
            fontSize: 28,
            color: C.muted,
            lineHeight: 1.6,
            marginTop: 38,
          }}
        >
          Workspaces. Agents. Evidence.
          <br />
          Together on your Mac.
        </div>
      </Interactive.Div>
      <Interactive.Div
        name="Cinderdeck icon orbit"
        style={{
          position: "absolute",
          left: 1130,
          top: 248,
          width: 650,
          height: 650,
          scale: interpolate(f, [0, 90], [0.82, 1], { ...clamp, easing: ease }),
          rotate: interpolate(f, [0, 110], ["-7deg", "0deg"], {
            ...clamp,
            easing: ease,
          }),
          opacity: interpolate(f, [0, 30], [0, 1], clamp),
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 40,
            borderRadius: "50%",
            background: "radial-gradient(circle,#ff6b2c22,transparent 67%)",
          }}
        />
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              inset: 20 + i * 38,
              border: `1px solid ${i === 1 ? "#ff6b2c27" : "#ffffff0c"}`,
              borderRadius: "50%",
              rotate: `${f * 0.08 + i * 20}deg`,
            }}
          >
            <div
              style={{
                position: "absolute",
                left: "50%",
                top: -4,
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: i === 1 ? C.orange : C.muted,
                boxShadow: `0 0 17px ${C.orange}`,
              }}
            />
          </div>
        ))}
        <Img
          src={staticFile("cinderdeck-icon.png")}
          style={{
            position: "absolute",
            width: 355,
            height: 355,
            left: 148,
            top: 140,
            filter: "drop-shadow(0 40px 65px #0008)",
            translate: `0px ${Math.sin(f / 70) * 8}px`,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: -12,
            top: 66,
            opacity: enter(f, 33),
            translate: `${(1 - enter(f, 33)) * -40}px 0px`,
            border: `1px solid ${C.line}`,
            borderRadius: 14,
            background: "#15191feb",
            padding: "15px 22px",
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontSize: 20,
          }}
        >
          <Layers size={23} color={C.orange} /> Workspaces
        </div>
        <div
          style={{
            position: "absolute",
            right: -26,
            top: 216,
            opacity: enter(f, 46),
            translate: `${(1 - enter(f, 46)) * 40}px 0px`,
            border: `1px solid ${C.line}`,
            borderRadius: 14,
            background: "#15191feb",
            padding: "15px 22px",
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontSize: 20,
          }}
        >
          <GitBranch size={23} color={C.blue} /> Parallel lanes
        </div>
        <div
          style={{
            position: "absolute",
            left: -30,
            top: 418,
            opacity: enter(f, 59),
            border: `1px solid ${C.line}`,
            borderRadius: 14,
            background: "#15191feb",
            padding: "15px 22px",
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontSize: 20,
          }}
        >
          <Radio size={23} color={C.green} /> MCP + CLI
        </div>
        <div
          style={{
            position: "absolute",
            right: 45,
            bottom: 45,
            opacity: enter(f, 72),
            border: `1px solid ${C.line}`,
            borderRadius: 14,
            background: "#15191feb",
            padding: "15px 22px",
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontSize: 20,
          }}
        >
          <Video size={23} color={C.purple} /> Video + logs
        </div>
      </Interactive.Div>
      <div
        style={{
          position: "absolute",
          bottom: 75,
          left: 96,
          fontFamily: mono,
          fontSize: 15,
          letterSpacing: 3,
          color: C.muted,
          opacity: enter(f, 100),
        }}
      >
        NATIVE macOS{" "}
        <span style={{ color: C.orange, margin: "0 20px" }}> / </span> LOCAL
        FIRST
      </div>
    </SceneFrame>
  );
};
