import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Command,
  GitBranch,
  Layers,
  Radio,
  Terminal,
} from "lucide-react";

export const C = {
  bg: "#090b0f",
  panel: "#13171e",
  raised: "#1b2029",
  line: "#303640",
  text: "#f5f3ec",
  muted: "#929aa8",
  orange: "#ff6b2c",
  amber: "#ffb66e",
  green: "#74dfba",
  blue: "#7db7ff",
  purple: "#ba9eff",
  red: "#ff7586",
};
export const mono = '"IBM Plex Mono", monospace';
export const ease = Easing.bezier(0.16, 1, 0.3, 1);
export const clamp = {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
} as const;
export const enter = (f: number, delay = 0, duration = 24) =>
  interpolate(f, [delay, delay + duration], [0, 1], { ...clamp, easing: ease });
export const range = (f: number, a: number, b: number) =>
  interpolate(f, [a, b], [0, 1], clamp);

export const Background = ({
  accent = C.orange,
  grid = true,
}: {
  accent?: string;
  grid?: boolean;
}) => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: C.bg, overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at ${65 + Math.sin(f / 120) * 8}% 70%, ${accent}12, transparent 57%)`,
        }}
      />
      {grid && (
        <AbsoluteFill
          style={{
            opacity: 0.27,
            backgroundImage:
              "linear-gradient(#4f5a6b26 1px, transparent 1px),linear-gradient(90deg,#4f5a6b26 1px,transparent 1px)",
            backgroundSize: "80px 80px",
            maskImage: "radial-gradient(ellipse,black,transparent 75%)",
          }}
        />
      )}
      <AbsoluteFill
        style={{
          background:
            "radial-gradient(ellipse at center,transparent 35%,#090b0f99 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 96,
          right: 96,
          top: 70,
          height: 1,
          background: "linear-gradient(90deg,#ffffff18,transparent)",
        }}
      />
    </AbsoluteFill>
  );
};

export const Brand = ({ dark = false }: { dark?: boolean }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      gap: 12,
      fontSize: 22,
      fontWeight: 650,
      color: dark ? C.bg : C.text,
    }}
  >
    <Img
      src={staticFile("cinderdeck-icon.png")}
      style={{ width: 34, height: 34 }}
    />
    Cinderdeck
  </div>
);
export const SceneFrame = ({
  children,
  number,
  label,
  accent = C.orange,
}: {
  children: React.ReactNode;
  number: string;
  label: string;
  accent?: string;
}) => (
  <AbsoluteFill style={{ fontFamily: "Inter, sans-serif", color: C.text }}>
    <Background accent={accent} />
    <div style={{ position: "absolute", left: 96, top: 25 }}>
      <Brand />
    </div>
    <div
      style={{
        position: "absolute",
        right: 96,
        top: 32,
        fontFamily: mono,
        fontSize: 16,
        color: C.muted,
        letterSpacing: 2,
      }}
    >
      {number} / 08{" "}
      <span style={{ color: accent, marginLeft: 25 }}>{label}</span>
    </div>
    {children}
  </AbsoluteFill>
);

export const Heading = ({
  eyebrow,
  children,
  sub,
  size = 82,
}: {
  eyebrow: string;
  children: React.ReactNode;
  sub?: string;
  size?: number;
}) => {
  const f = useCurrentFrame();
  return (
    <Interactive.Div
      name="Scene headline"
      style={{
        position: "absolute",
        left: 96,
        top: 115,
        opacity: interpolate(f, [0, 20], [0, 1], clamp),
        translate: interpolate(f, [0, 30], ["0px 28px", "0px 0px"], {
          ...clamp,
          easing: ease,
        }),
      }}
    >
      <div
        style={{
          fontFamily: mono,
          fontSize: 17,
          letterSpacing: 4,
          color: C.orange,
          marginBottom: 22,
        }}
      >
        {eyebrow}
      </div>
      <div
        style={{
          fontSize: size,
          fontWeight: 640,
          letterSpacing: -4,
          lineHeight: 1.07,
        }}
      >
        {children}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 27,
            lineHeight: 1.4,
            color: C.muted,
            marginTop: 22,
          }}
        >
          {sub}
        </div>
      )}
    </Interactive.Div>
  );
};

export const Footer = ({
  children,
  color = C.muted,
}: {
  children: React.ReactNode;
  color?: string;
}) => (
  <div
    style={{
      position: "absolute",
      bottom: 53,
      left: 96,
      right: 96,
      display: "flex",
      alignItems: "center",
      gap: 16,
      color,
      fontSize: 23,
    }}
  >
    <span style={{ width: 30, height: 2, background: C.orange }} />
    {children}
  </div>
);
export const Tag = ({
  children,
  color = C.green,
  small = false,
}: {
  children: React.ReactNode;
  color?: string;
  small?: boolean;
}) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 7,
      border: `1px solid ${color}30`,
      background: `${color}10`,
      color,
      padding: small ? "5px 10px" : "8px 14px",
      borderRadius: 8,
      fontSize: small ? 15 : 19,
      whiteSpace: "nowrap",
    }}
  >
    {children}
  </div>
);
export const Dot = ({
  color = C.green,
  size = 8,
}: {
  color?: string;
  size?: number;
}) => (
  <span
    style={{
      display: "inline-block",
      width: size,
      height: size,
      borderRadius: 20,
      background: color,
      boxShadow: `0 0 ${size * 2}px ${color}50`,
    }}
  />
);
export const AppWindow = ({
  children,
  title = "Workspaces",
  style,
  toolbar,
}: {
  children: React.ReactNode;
  title?: string;
  style?: React.CSSProperties;
  toolbar?: React.ReactNode;
}) => (
  <div
    style={{
      border: "1px solid #454b57",
      borderRadius: 18,
      background: "linear-gradient(140deg,#1b2028,#11151b)",
      boxShadow: "0 50px 100px #0009,0 0 0 1px #0008,inset 0 1px 0 #ffffff10",
      overflow: "hidden",
      ...style,
    }}
  >
    <div
      style={{
        height: 58,
        padding: "0 23px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        borderBottom: `1px solid ${C.line}`,
        background: "#21252c",
      }}
    >
      {["#ff655d", "#f5bd4f", "#5ccb69"].map((x) => (
        <span
          key={x}
          style={{ width: 12, height: 12, borderRadius: 10, background: x }}
        />
      ))}
      <span
        style={{
          marginLeft: 15,
          fontSize: 19,
          color: "#c7ccd5",
          fontWeight: 550,
        }}
      >
        {title}
      </span>
      <span style={{ marginLeft: "auto" }}>{toolbar}</span>
    </div>
    {children}
  </div>
);
export const Sidebar = ({ active = "Services" }: { active?: string }) => (
  <div
    style={{
      width: 219,
      flexShrink: 0,
      background: "#10141ae0",
      borderRight: `1px solid ${C.line}`,
      padding: "25px 15px",
      fontSize: 19,
    }}
  >
    <div
      style={{
        fontFamily: mono,
        fontSize: 12,
        color: C.muted,
        letterSpacing: 2,
        padding: "0 12px 15px",
      }}
    >
      WORKSPACES
    </div>
    <div
      style={{
        background: "#ff6b2c19",
        color: C.orange,
        borderRadius: 9,
        padding: "12px 14px",
        display: "flex",
        gap: 10,
        alignItems: "center",
      }}
    >
      <Layers size={20} /> Orbit
    </div>
    <div
      style={{
        padding: "13px 18px 20px 28px",
        fontSize: 16,
        color: C.muted,
        display: "flex",
        gap: 10,
      }}
    >
      <GitBranch size={16} /> main
    </div>
    {["Services", "Tasks", "Workflows", "Lane map", "Runs", "Recordings"].map(
      (t) => (
        <div
          key={t}
          style={{
            marginTop: 5,
            padding: "11px 14px",
            background: active === t ? "#ffffff0b" : "transparent",
            borderRadius: 8,
            color: active === t ? C.text : C.muted,
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          {t}
          {active === t && <ChevronRight size={18} />}
        </div>
      ),
    )}
    <div
      style={{
        marginTop: 22,
        padding: "17px 12px",
        borderTop: `1px solid ${C.line}`,
        color: C.muted,
        display: "flex",
        gap: 10,
        fontSize: 17,
      }}
    >
      <Radio size={18} /> Agent access
    </div>
  </div>
);
export const Cursor = ({
  x,
  y,
  click = 0,
  label,
}: {
  x: number;
  y: number;
  click?: number;
  label?: string;
}) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      zIndex: 30,
      filter: "drop-shadow(0 4px 7px #0008)",
    }}
  >
    {click > 0 && (
      <div
        style={{
          position: "absolute",
          left: -24 * click,
          top: -24 * click,
          width: 48 * click,
          height: 48 * click,
          border: "2px solid #ffb66e",
          borderRadius: 100,
          opacity: 1 - click,
        }}
      />
    )}
    <svg width="27" height="34" viewBox="0 0 27 34">
      <path
        d="M2 2 L23 22 L13 22 L9 31 Z"
        fill="#fff"
        stroke="#171b21"
        strokeWidth="2"
      />
    </svg>
    {label && (
      <div
        style={{
          background: C.orange,
          color: C.bg,
          fontSize: 15,
          fontWeight: 600,
          padding: "5px 9px",
          borderRadius: 6,
          marginLeft: 20,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </div>
    )}
  </div>
);
export const CheckIcon = ({ size = 20 }: { size?: number }) => (
  <Check size={size} color={C.green} />
);

export const ToolCall = ({
  name,
  args,
  status = "Complete",
  color = C.green,
}: {
  name: string;
  args: string;
  status?: string;
  color?: string;
}) => (
  <div
    style={{
      background: "#0e1218",
      border: `1px solid ${C.line}`,
      padding: "18px 22px",
      borderRadius: 12,
    }}
  >
    <div
      style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 20 }}
    >
      <Terminal size={21} color={C.orange} />
      <span style={{ fontFamily: mono }}>{name}</span>
      <span style={{ marginLeft: "auto", color, fontSize: 16 }}>{status}</span>
    </div>
    <div
      style={{ fontFamily: mono, fontSize: 16, color: C.muted, marginTop: 12 }}
    >
      {args}
    </div>
  </div>
);
export const Shortcut = ({ children }: { children: React.ReactNode }) => (
  <span
    style={{
      display: "inline-flex",
      gap: 8,
      alignItems: "center",
      padding: "7px 12px",
      borderRadius: 7,
      border: `1px solid ${C.line}`,
      color: C.muted,
      fontSize: 17,
    }}
  >
    <Command size={17} />
    {children}
  </span>
);
export const LinkLabel = ({ children }: { children: React.ReactNode }) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 9,
      color: C.orange,
    }}
  >
    {children}
    <ArrowUpRight size={21} />
  </span>
);

export const FlowPath = ({
  d,
  color = C.orange,
  delay = 0,
  travel = 65,
  width = 3,
}: {
  d: string;
  color?: string;
  delay?: number;
  travel?: number;
  width?: number;
}) => {
  const f = useCurrentFrame();
  const p = enter(f, delay, 45);
  const move = ((Math.max(0, f - delay) / travel) % 1) * 100;
  return (
    <g opacity={p}>
      <path d={d} fill="none" stroke={`${color}25`} strokeWidth={width} />
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={width}
        pathLength={100}
        strokeDasharray="7 93"
        strokeDashoffset={-move}
        opacity={f > delay ? 0.85 : 0}
      />
    </g>
  );
};
