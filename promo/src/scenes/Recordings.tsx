import { Interactive, interpolate, useCurrentFrame } from "remotion";
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  Flag,
  Layers,
  Play,
  Search,
  ShoppingBag,
  SlidersHorizontal,
  Video,
} from "lucide-react";
import {
  AppWindow,
  C,
  clamp,
  Cursor,
  ease,
  enter,
  Footer,
  Heading,
  mono,
  SceneFrame,
  Tag,
} from "../design";

const logLines = [
  {
    t: "00:02.100",
    source: "web",
    text: "GET /checkout 200",
    at: 2.1,
    color: C.blue,
  },
  {
    t: "00:04.260",
    source: "agent",
    text: "▶ Open checkout",
    at: 4.26,
    color: C.orange,
  },
  {
    t: "00:07.800",
    source: "agent",
    text: "▶ Click Place order",
    at: 7.8,
    color: C.orange,
  },
  {
    t: "00:08.420",
    source: "api",
    text: "ERROR Payment request failed",
    at: 8.42,
    color: C.red,
  },
  {
    t: "00:08.426",
    source: "web",
    text: "POST /api/orders 500",
    at: 8.426,
    color: C.red,
  },
  {
    t: "00:09.010",
    source: "agent",
    text: "✕ Order confirmation missing",
    at: 9.01,
    color: C.red,
  },
];
export const ShopPreview = ({
  error = false,
  compact = false,
}: {
  error?: boolean;
  compact?: boolean;
}) => (
  <div
    style={{
      background: "#ecebe6",
      color: "#1a302c",
      height: "100%",
      padding: compact ? 22 : 19,
      boxSizing: "border-box",
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        fontSize: compact ? 19 : 22,
        fontWeight: 650,
      }}
    >
      <ShoppingBag size={compact ? 20 : 25} /> ORBIT
      <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 400 }}>
        THE EVERYDAY COLLECTION
      </span>
    </div>
    <div style={{ display: "flex", gap: 24, marginTop: compact ? 19 : 18 }}>
      <div
        style={{
          width: "38%",
          background: "#d2d8ca",
          height: compact ? 135 : 153,
          borderRadius: 9,
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            width: compact ? 67 : 92,
            height: compact ? 99 : 110,
            left: "50%",
            top: compact ? 19 : 22,
            translate: "-50% 0",
            borderRadius: "22px 22px 14px 14px",
            background: "linear-gradient(110deg,#33534b,#658776 45%,#2e5147)",
            boxShadow: "14px 18px 22px #0003",
          }}
        >
          <div
            style={{
              width: "50%",
              height: 12,
              background: "#15352a",
              margin: "-8px auto 0",
              borderRadius: 5,
            }}
          />
          <div
            style={{ height: 1, background: "#9fae9244", marginTop: "65%" }}
          />
        </div>
      </div>
      <div style={{ flex: 1 }}>
        <div
          style={{
            fontSize: compact ? 11 : 13,
            color: "#6e7a72",
            marginBottom: 4,
          }}
        >
          YOUR ORDER
        </div>
        <div style={{ fontSize: compact ? 18 : 23, fontWeight: 650 }}>
          Everyday Flask
        </div>
        <div
          style={{
            fontSize: compact ? 12 : 15,
            marginTop: 5,
            color: "#728073",
          }}
        >
          Forest · 750 ml
        </div>
        <div
          style={{ fontSize: compact ? 17 : 20, marginTop: compact ? 8 : 10 }}
        >
          $38.00
        </div>
        <div
          style={{
            padding: compact ? "8px 12px" : "9px 18px",
            background: "#234e40",
            borderRadius: 7,
            color: "#fff",
            textAlign: "center",
            fontSize: compact ? 14 : 16,
            marginTop: compact ? 9 : 11,
          }}
        >
          Place order
        </div>
      </div>
    </div>
    {error && (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: "#ab3442",
          background: "#ffdbd9",
          border: "1px solid #d59697",
          borderRadius: 7,
          padding: compact ? "9px 12px" : "13px 15px",
          marginTop: 17,
          fontSize: compact ? 13 : 17,
        }}
      >
        <AlertCircle size={18} />
        Something went wrong. Please try again.
      </div>
    )}
  </div>
);

export const Recordings = () => {
  const f = useCurrentFrame();
  const time = interpolate(
    f,
    [0, 28, 126, 170, 190, 220, 299],
    [0, 0, 8.42, 11.2, 11.2, 8.42, 8.42],
    clamp,
  );
  const jumped = f > 220;
  const error = time >= 8.42;
  return (
    <SceneFrame number="06" label="RECORDINGS + LOGS" accent={C.red}>
      <Heading
        eyebrow="STOP GUESSING WHAT HAPPENED"
        sub="Choose your workspace logs. Mark the steps. Jump straight to the failure."
      >
        The moment. The logs. <span style={{ color: C.orange }}>Together.</span>
      </Heading>
      <Interactive.Div
        name="Synchronized video and logs editor"
        style={{
          position: "absolute",
          left: 96,
          top: 351,
          width: 1728,
          opacity: interpolate(f, [8, 30], [0, 1], clamp),
          translate: interpolate(f, [8, 43], ["0px 80px", "0px 0px"], {
            ...clamp,
            easing: ease,
          }),
        }}
      >
        <AppWindow
          title="Checkout regression — Cinderdeck"
          toolbar={
            <div style={{ display: "flex", gap: 11 }}>
              <Tag small color={C.muted}>
                <Layers size={15} /> Orbit + Backend
              </Tag>
              <Tag small color={error ? C.red : C.green}>
                {error ? "Failed check" : "Recording"}
              </Tag>
            </div>
          }
        >
          <div style={{ display: "flex", height: 374 }}>
            <div
              style={{
                width: 780,
                padding: 19,
                boxSizing: "border-box",
                borderRight: `1px solid ${C.line}`,
                background: "#0c1015",
              }}
            >
              <div
                style={{
                  height: 28,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  fontSize: 12,
                  color: C.muted,
                  background: "#20262f",
                  padding: "0 13px",
                  borderRadius: "8px 8px 0 0",
                }}
              >
                <Circle size={8} />
                <ChevronLeft size={12} />
                <span style={{ marginLeft: 30 }}>localhost:3100/checkout</span>
                <span style={{ marginLeft: "auto" }}>Recorded window</span>
              </div>
              <div
                style={{
                  height: 307,
                  overflow: "hidden",
                  borderRadius: "0 0 8px 8px",
                }}
              >
                <ShopPreview error={error} />
              </div>
            </div>
            <div style={{ flex: 1, padding: 22, background: "#10151c" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 13,
                  fontSize: 20,
                }}
              >
                <SlidersHorizontal size={21} />
                <b>Logs</b>
                <span
                  style={{ fontSize: 14, color: C.muted, marginLeft: "auto" }}
                >
                  All sources
                </span>
                <Search size={18} color={C.muted} />
              </div>
              <div
                style={{ height: 1, background: C.line, margin: "17px 0 11px" }}
              />
              {logLines.map((l, i) => (
                <div
                  key={l.t}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 15,
                    padding: "9px 10px",
                    fontFamily: mono,
                    fontSize: 16,
                    borderRadius: 6,
                    background: i === 3 && error ? "#ff758619" : "transparent",
                    border:
                      i === 3 && error
                        ? "1px solid #ff75865a"
                        : "1px solid transparent",
                    opacity: time >= l.at ? 1 : 0.21,
                  }}
                >
                  <span
                    style={{ color: i === 3 ? C.red : C.muted, minWidth: 110 }}
                  >
                    {l.t}
                  </span>
                  <span style={{ color: l.color, width: 57 }}>{l.source}</span>
                  <span style={{ color: i > 2 ? C.red : "#d7dce4" }}>
                    {l.text}
                  </span>
                  {i === 3 && jumped && <ChevronLeft size={19} color={C.red} />}
                </div>
              ))}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  color: C.orange,
                  fontSize: 16,
                  marginTop: 12,
                  opacity: enter(f, 150),
                }}
              >
                <ChevronLeft size={15} />
                <ChevronRight size={15} /> Step through errors · click any log
                to seek
              </div>
            </div>
          </div>
          <div
            style={{
              height: 135,
              padding: "17px 24px",
              borderTop: `1px solid ${C.line}`,
              background: "#171c24",
              position: "relative",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 15,
                fontFamily: mono,
                fontSize: 16,
              }}
            >
              <Play size={18} fill={C.text} />
              <span>{`00:${time.toFixed(2).padStart(5, "0")}`}</span>
              <span style={{ color: C.muted }}>/ 00:14.00</span>
              <span
                style={{
                  marginLeft: "auto",
                  fontFamily: "Inter",
                  color: jumped ? C.red : C.muted,
                  display: "flex",
                  gap: 9,
                  alignItems: "center",
                }}
              >
                {jumped ? <AlertCircle size={18} /> : <Video size={18} />}{" "}
                {jumped
                  ? "First error · 00:08.420"
                  : "Video, events, and output share one timeline"}
              </span>
            </div>
            <div
              style={{
                position: "relative",
                height: 46,
                marginTop: 19,
                borderRadius: 7,
                background: "#222d3a",
                overflow: "visible",
              }}
            >
              {Array.from({ length: 56 }, (_, i) => (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    left: `${i * 1.8}%`,
                    top: 8,
                    width: 19,
                    height: 29,
                    opacity: 0.45,
                    background: i > 30 ? "#877567" : "#6a8580",
                    borderRadius: 2,
                  }}
                />
              ))}
              {[4.26, 7.8, 8.42, 9.01].map((v, i) => (
                <div
                  key={v}
                  style={{
                    position: "absolute",
                    left: `${(v / 14) * 100}%`,
                    top: -10,
                    width: 2,
                    height: 66,
                    background: i > 1 ? C.red : C.orange,
                  }}
                >
                  {i < 2 && (
                    <Flag
                      size={14}
                      fill={C.orange}
                      color={C.orange}
                      style={{ position: "absolute", top: -8 }}
                    />
                  )}
                </div>
              ))}
              <div
                style={{
                  position: "absolute",
                  left: `${(time / 14) * 100}%`,
                  top: -8,
                  height: 68,
                  width: 2,
                  background: C.text,
                  boxShadow: "0 0 15px #fff5",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: -5,
                    top: 0,
                    width: 12,
                    height: 10,
                    borderRadius: "3px 3px 5px 5px",
                    background: C.text,
                  }}
                />
              </div>
            </div>
            <div
              style={{
                position: "relative",
                height: 15,
                fontFamily: mono,
                fontSize: 12,
                color: C.muted,
                marginTop: 7,
              }}
            >
              {[0, 4, 8, 12, 14].map((seconds) => (
                <span
                  key={seconds}
                  style={{
                    position: "absolute",
                    left: `${(seconds / 14) * 100}%`,
                    translate: seconds === 14 ? "-100% 0" : "0 0",
                  }}
                >
                  00:{String(seconds).padStart(2, "0")}
                </span>
              ))}
            </div>
          </div>
        </AppWindow>
        <Cursor
          x={interpolate(f, [156, 196], [1310, 1220], {
            ...clamp,
            easing: ease,
          })}
          y={interpolate(f, [156, 196], [380, 283], { ...clamp, easing: ease })}
          click={f > 209 && f < 227 ? (f - 209) / 18 : 0}
        />
      </Interactive.Div>
      <div
        style={{
          position: "absolute",
          left: 601,
          top: 802,
          padding: "12px 19px",
          borderRadius: 10,
          border: `1px solid ${C.red}70`,
          background: "#321e26",
          color: C.red,
          fontSize: 23,
          fontWeight: 600,
          boxShadow: "0 15px 35px #0008",
          opacity: enter(f, 226),
          translate: `0px ${(1 - enter(f, 226)) * 25}px`,
        }}
      >
        00:08.420{" "}
        <span
          style={{
            fontWeight: 400,
            fontSize: 19,
            color: C.text,
            marginLeft: 14,
          }}
        >
          Exact frame. Nearby logs.
        </span>
      </div>
      <Footer>
        <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <Check size={19} color={C.green} /> Video timestamps
        </span>
        <span style={{ color: C.line }}> / </span>Action markers
        <span style={{ color: C.line }}> / </span>Branches, commits, and diffs
      </Footer>
    </SceneFrame>
  );
};
