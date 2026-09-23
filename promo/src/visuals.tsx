import React from "react";
import {
  AbsoluteFill,
  CanvasImage,
  Easing,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

export const Canvas: React.FC<{
  children: React.ReactNode;
  chapter?: string;
}> = ({ children, chapter }) => (
  <AbsoluteFill
    style={{
      backgroundColor: "#101112",
      color: "#f8f5f0",
      fontFamily: "Arial, Helvetica, sans-serif",
      overflow: "hidden",
    }}
  >
    <div
      style={{
        position: "absolute",
        inset: 0,
        background:
          "radial-gradient(ellipse at 85% 5%, rgba(255,102,28,0.10), transparent 50%)",
      }}
    />
    <div
      style={{
        position: "absolute",
        left: 100,
        top: 60,
        display: "flex",
        alignItems: "center",
        gap: 14,
        color: "#c6c0b8",
        fontSize: 22,
        letterSpacing: 3,
      }}
    >
      <span
        style={{ width: 9, height: 9, background: "#ff661c", borderRadius: 2 }}
      />{" "}
      CINDERDECK
    </div>
    {chapter && (
      <div
        style={{
          position: "absolute",
          right: 100,
          top: 60,
          color: "#aaa49b",
          fontSize: 22,
          letterSpacing: 2,
        }}
      >
        {chapter}
      </div>
    )}
    {children}
    {chapter && (
      <div
        style={{
          position: "absolute",
          bottom: 28,
          right: 100,
          color: "#8c8984",
          fontSize: 17,
        }}
      >
        Native app · Sample workspace
      </div>
    )}
  </AbsoluteFill>
);

export const Heading: React.FC<{
  eyebrow: string;
  title: string;
  detail?: string;
}> = ({ eyebrow, title, detail }) => {
  const frame = useCurrentFrame();
  return (
    <Interactive.Div
      name={eyebrow}
      style={{
        position: "absolute",
        left: 100,
        top: 122,
        opacity: interpolate(frame, [0, 18], [0, 1], {
          extrapolateRight: "clamp",
        }),
        translate: interpolate(frame, [0, 24], ["0px 16px", "0px 0px"], {
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.cubic),
        }),
      }}
    >
      <div
        style={{
          color: "#ff8a50",
          fontSize: 22,
          fontWeight: 700,
          letterSpacing: 3,
          marginBottom: 14,
        }}
      >
        {eyebrow}
      </div>
      <div
        style={{
          fontSize: 76,
          fontWeight: 700,
          letterSpacing: -3,
          lineHeight: 1.08,
        }}
      >
        {title}
      </div>
      {detail && (
        <div style={{ fontSize: 30, color: "#b7b3ac", marginTop: 18 }}>
          {detail}
        </div>
      )}
    </Interactive.Div>
  );
};

type Crop = { x: number; y: number; width: number; height: number };
/** Camera moves crop the real 2x native render. No UI is redrawn in HTML. */
export const Screen: React.FC<{
  src: string;
  nativeWidth: number;
  nativeHeight: number;
  crop?: Crop;
  x: number;
  y: number;
  width: number;
  height: number;
  delay?: number;
}> = ({
  src,
  nativeWidth,
  nativeHeight,
  crop,
  x,
  y,
  width,
  height,
  delay = 0,
}) => {
  const frame = useCurrentFrame();
  const area = crop ?? { x: 0, y: 0, width: nativeWidth, height: nativeHeight };
  const scale = Math.min(width / area.width, height / area.height);
  const w = area.width * scale,
    h = area.height * scale;
  return (
    <div
      style={{
        position: "absolute",
        left: x + (width - w) / 2,
        top: y + (height - h) / 2,
        width: w,
        height: h,
        overflow: "hidden",
        borderRadius: 22,
        border: "1px solid #454342",
        boxShadow: "0 35px 70px #0008",
        background: "#202020",
        opacity: interpolate(frame, [delay, delay + 18], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        }),
        translate: interpolate(
          frame,
          [delay, delay + 24],
          ["0px 22px", "0px 0px"],
          {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.out(Easing.cubic),
          },
        ),
      }}
    >
      <CanvasImage
        src={staticFile(`screens/${src}.png`)}
        style={{
          position: "absolute",
          width: nativeWidth * scale,
          height: nativeHeight * scale,
          left: -area.x * scale,
          top: -area.y * scale,
        }}
      />
    </div>
  );
};

export const Tag: React.FC<{ children: React.ReactNode; active?: boolean }> = ({
  children,
  active,
}) => (
  <span
    style={{
      padding: "16px 27px",
      borderRadius: 50,
      border: `1px solid ${active ? "#ff661c" : "#4d4944"}`,
      background: active ? "#ff661c19" : "#18191a",
      fontSize: 28,
      color: active ? "#ff9c69" : "#d0ccc5",
    }}
  >
    {children}
  </span>
);

export const DemoCursor: React.FC<{
  start: number;
  click: number;
  from: [number, number];
  to: [number, number];
}> = ({ start, click, from, to }) => {
  const frame = useCurrentFrame();
  const x = interpolate(frame, [start, click - 8], [from[0], to[0]], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  const y = interpolate(frame, [start, click - 8], [from[1], to[1]], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.cubic),
  });
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        opacity: interpolate(
          frame,
          [start, start + 8, click + 10, click + 18],
          [0, 1, 1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        ),
      }}
    >
      {frame >= click && (
        <div
          style={{
            position: "absolute",
            width: 72,
            height: 72,
            left: -36,
            top: -36,
            borderRadius: "50%",
            border: "3px solid #ff8a50",
            scale: interpolate(frame, [click, click + 18], [0.3, 1.5], {
              extrapolateRight: "clamp",
            }),
            opacity: interpolate(frame, [click, click + 18], [0.8, 0], {
              extrapolateRight: "clamp",
            }),
          }}
        />
      )}
      <svg
        width="34"
        height="45"
        viewBox="0 0 28 38"
        style={{ filter: "drop-shadow(0 2px 3px #0009)" }}
      >
        <path
          d="M2 2 L2 30 L9 23 L15 35 L21 32 L15 21 L25 21 Z"
          fill="white"
          stroke="#171717"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
};
