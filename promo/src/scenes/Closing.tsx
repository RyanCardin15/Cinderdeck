import {
  Img,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import {
  ArrowUpRight,
  Camera,
  Check,
  Clipboard,
  GitPullRequest,
} from "lucide-react";
import { Background, C, clamp, ease, enter, FlowPath, mono } from "../design";

export const Closing = () => {
  const f = useCurrentFrame();
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        fontFamily: "Inter, sans-serif",
        color: C.text,
      }}
    >
      <Background />
      <svg
        width="1920"
        height="1080"
        style={{ position: "absolute", opacity: 0.5 }}
      >
        <FlowPath d="M-100 345 H420 Q680 345 795 300 L960 270" delay={0} />
        <FlowPath
          d="M2020 345 H1500 Q1240 345 1125 300 L960 270"
          color={C.blue}
          delay={4}
        />
        <FlowPath d="M960 1120 V990" color={C.green} delay={9} />
      </svg>
      <Interactive.Div
        name="Closing icon"
        style={{
          position: "absolute",
          left: 844,
          top: 110,
          width: 232,
          height: 232,
          scale: interpolate(f, [0, 55], [0.72, 1], { ...clamp, easing: ease }),
          translate: interpolate(f, [0, 55], ["0px 60px", "0px 0px"], {
            ...clamp,
            easing: ease,
          }),
          opacity: interpolate(f, [0, 25], [0, 1], clamp),
        }}
      >
        <Img
          src={staticFile("cinderdeck-icon.png")}
          style={{
            width: 232,
            height: 232,
            filter: "drop-shadow(0 20px 65px #ff6b2c18)",
          }}
        />
      </Interactive.Div>
      <Interactive.Div
        name="Cinderdeck wordmark"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 354,
          textAlign: "center",
          fontSize: 137,
          fontWeight: 650,
          letterSpacing: -8,
          opacity: interpolate(f, [13, 37], [0, 1], clamp),
          translate: interpolate(f, [13, 48], ["0px 35px", "0px 0px"], {
            ...clamp,
            easing: ease,
          }),
        }}
      >
        Cinderdeck
      </Interactive.Div>
      <Interactive.Div
        name="Closing promise"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 531,
          textAlign: "center",
          fontSize: 37,
          letterSpacing: -1,
          color: C.muted,
          opacity: interpolate(f, [31, 55], [0, 1], clamp),
        }}
      >
        Your development.{" "}
        <span style={{ color: C.orange }}>Under control.</span>
      </Interactive.Div>
      <div
        style={{
          position: "absolute",
          top: 619,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
          gap: 28,
          fontSize: 19,
          color: C.text,
          opacity: enter(f, 44),
        }}
      >
        {["Native macOS", "Local first", "No account required"].map((t) => (
          <span
            key={t}
            style={{ display: "flex", alignItems: "center", gap: 9 }}
          >
            <Check size={18} color={C.green} />
            {t}
          </span>
        ))}
      </div>
      <Interactive.Div
        name="Repository call to action"
        style={{
          position: "absolute",
          left: 440,
          top: 707,
          width: 1040,
          padding: "24px 0",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          gap: 17,
          border: "1px solid #ff6b2c60",
          background: "linear-gradient(120deg,#ff6b2c17,#ff6b2c07)",
          borderRadius: 14,
          fontSize: 25,
          fontFamily: mono,
          opacity: interpolate(f, [53, 79], [0, 1], clamp),
          translate: interpolate(f, [53, 90], ["0px 25px", "0px 0px"], {
            ...clamp,
            easing: ease,
          }),
        }}
      >
        github.com/RyanCardin15/Cinderdeck{" "}
        <ArrowUpRight size={27} color={C.orange} />
      </Interactive.Div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 872,
          textAlign: "center",
          opacity: enter(f, 71),
        }}
      >
        <div
          style={{
            fontFamily: mono,
            fontSize: 13,
            color: C.muted,
            letterSpacing: 3,
            marginBottom: 21,
          }}
        >
          PLUS THE TOOLS THAT KEEP YOU IN FLOW
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            gap: 55,
            fontSize: 19,
            color: "#a7afbc",
          }}
        >
          <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <Camera size={21} color={C.orange} /> Capture & annotate
          </span>
          <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <GitPullRequest size={21} color={C.blue} /> GitHub pull requests
          </span>
          <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <Clipboard size={21} color={C.purple} /> Clipboard history
          </span>
        </div>
      </div>
    </div>
  );
};
