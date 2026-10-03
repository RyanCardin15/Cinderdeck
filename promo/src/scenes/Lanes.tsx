import { Interactive, interpolate, useCurrentFrame } from "remotion";
import {
  ArrowUpRight,
  Database,
  GitBranch,
  Globe,
  Box,
  Layers,
  Maximize,
  MousePointer2,
} from "lucide-react";
import {
  AppWindow,
  C,
  clamp,
  Dot,
  ease,
  enter,
  FlowPath,
  Footer,
  Heading,
  mono,
  SceneFrame,
  Tag,
} from "../design";

const lanes = [
  {
    branch: "main",
    owner: "Original checkout",
    web: 3000,
    api: 4000,
    color: C.orange,
    at: 17,
  },
  {
    branch: "feature/search",
    owner: "Codex",
    web: 3100,
    api: 4100,
    color: C.blue,
    at: 53,
  },
  {
    branch: "fix/checkout",
    owner: "Claude Code",
    web: 3200,
    api: 4200,
    color: C.purple,
    at: 89,
  },
];
export const Lanes = () => {
  const f = useCurrentFrame();
  return (
    <SceneFrame number="03" label="PARALLEL LANES" accent={C.blue}>
      <Heading
        eyebrow="GIVE EVERY BRANCH ITS OWN SPACE"
        sub="Isolated worktrees. Assigned ports. Separate processes and logs."
      >
        More branches. <span style={{ color: C.blue }}>Less friction.</span>
      </Heading>
      <Interactive.Div
        name="Animated lane execution map"
        style={{
          position: "absolute",
          left: 96,
          top: 352,
          width: 1728,
          opacity: interpolate(f, [10, 35], [0, 1], clamp),
          translate: interpolate(f, [10, 45], ["0px 70px", "0px 0px"], {
            ...clamp,
            easing: ease,
          }),
        }}
      >
        <AppWindow
          title="Orbit — Lane map"
          toolbar={
            <div
              style={{
                display: "flex",
                gap: 22,
                color: C.muted,
                fontSize: 15,
                alignItems: "center",
              }}
            >
              <span>Overview</span>
              <span>Used by</span>
              <Maximize size={17} />
              <span>Fit width</span>
            </div>
          }
        >
          <div
            style={{
              position: "relative",
              height: 509,
              backgroundImage: "radial-gradient(#66707e30 1px,transparent 1px)",
              backgroundSize: "22px 22px",
            }}
          >
            <svg width="1728" height="509" style={{ position: "absolute" }}>
              {lanes.map((l, i) => (
                <g key={l.branch}>
                  <FlowPath
                    d={`M392 ${96 + i * 144} H490`}
                    color={l.color}
                    delay={l.at + 12}
                  />
                  <FlowPath
                    d={`M755 ${96 + i * 144} H881`}
                    color={l.color}
                    delay={l.at + 27}
                  />
                  <FlowPath
                    d={`M1146 ${96 + i * 144} H1220 Q1260 ${96 + i * 144} 1260 242 H1381`}
                    color={l.color}
                    delay={l.at + 42}
                    travel={95}
                  />
                </g>
              ))}
            </svg>
            {lanes.map((l, i) => (
              <div
                key={l.branch}
                style={{
                  position: "absolute",
                  left: 24,
                  right: 370,
                  top: 27 + i * 144,
                  height: 130,
                  opacity: enter(f, l.at),
                  translate: `${(1 - enter(f, l.at)) * -100}px 0px`,
                  borderRadius: 14,
                  border: `1px solid ${l.color}30`,
                  background: `linear-gradient(90deg,${l.color}0c,transparent 90%)`,
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: 21,
                    top: 26,
                    width: 340,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: 11,
                      alignItems: "center",
                      color: l.color,
                      fontSize: 23,
                      fontWeight: 600,
                    }}
                  >
                    <GitBranch size={24} />
                    {l.branch}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 11,
                      alignItems: "center",
                      fontSize: 16,
                      color: C.muted,
                      marginTop: 17,
                    }}
                  >
                    <span
                      style={{
                        border: `1px solid ${l.color}35`,
                        padding: "4px 9px",
                        borderRadius: 6,
                        color: l.color,
                      }}
                    >
                      {l.owner}
                    </span>
                    <span>{i === 0 ? "source" : "worktree"}</span>
                  </div>
                </div>
                <div
                  style={{
                    position: "absolute",
                    left: 466,
                    top: 20,
                    width: 264,
                    height: 88,
                    padding: "15px 18px",
                    background: "#1b212b",
                    border: `1px solid ${l.color}50`,
                    borderRadius: 11,
                    boxSizing: "border-box",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: 9,
                      alignItems: "center",
                      fontSize: 20,
                    }}
                  >
                    <Globe size={20} color={l.color} />
                    web
                    <span style={{ marginLeft: "auto" }}>
                      <Dot size={7} />
                    </span>
                  </div>
                  <div
                    style={{
                      fontFamily: mono,
                      color: C.muted,
                      fontSize: 15,
                      marginTop: 10,
                    }}
                  >
                    localhost:<span style={{ color: l.color }}>{l.web}</span>
                  </div>
                </div>
                <div
                  style={{
                    position: "absolute",
                    left: 856,
                    top: 20,
                    width: 264,
                    height: 88,
                    padding: "15px 18px",
                    background: "#1b212b",
                    border: `1px solid ${l.color}50`,
                    borderRadius: 11,
                    boxSizing: "border-box",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      gap: 9,
                      alignItems: "center",
                      fontSize: 20,
                    }}
                  >
                    <Box size={20} color={l.color} />
                    api
                    <span style={{ marginLeft: "auto" }}>
                      <Dot size={7} />
                    </span>
                  </div>
                  <div
                    style={{
                      fontFamily: mono,
                      color: C.muted,
                      fontSize: 15,
                      marginTop: 10,
                    }}
                  >
                    localhost:<span style={{ color: l.color }}>{l.api}</span>
                  </div>
                </div>
              </div>
            ))}
            <div
              style={{
                position: "absolute",
                left: 1380,
                top: 140,
                width: 293,
                height: 218,
                border: `1px dashed ${C.green}60`,
                borderRadius: 15,
                background: "#14201e",
                padding: 23,
                boxSizing: "border-box",
                opacity: enter(f, 65),
              }}
            >
              <div
                style={{
                  fontFamily: mono,
                  fontSize: 13,
                  color: C.green,
                  letterSpacing: 2,
                }}
              >
                SHARED RESOURCE
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  fontSize: 24,
                  marginTop: 26,
                }}
              >
                <Database size={26} color={C.green} />
                Postgres
              </div>
              <div
                style={{
                  fontFamily: mono,
                  fontSize: 17,
                  color: C.muted,
                  marginTop: 15,
                }}
              >
                localhost:5432
              </div>
              <div style={{ marginTop: 21, fontSize: 17, color: C.green }}>
                <Dot size={7} /> One instance, all lanes
              </div>
            </div>
            <div
              style={{
                position: "absolute",
                bottom: 17,
                left: 32,
                display: "flex",
                gap: 25,
                fontSize: 14,
                color: C.muted,
              }}
            >
              <span style={{ display: "flex", gap: 7, alignItems: "center" }}>
                <Layers size={15} /> 3 checkouts
              </span>
              <span>6 isolated services</span>
              <span>1 shared database</span>
              <span style={{ marginLeft: 510, display: "flex", gap: 8 }}>
                <MousePointer2 size={15} /> Inspect a process. Follow its
                dependencies.
              </span>
            </div>
          </div>
        </AppWindow>
      </Interactive.Div>
      <div
        style={{
          position: "absolute",
          right: 130,
          bottom: 91,
          opacity: enter(f, 170),
          display: "flex",
          gap: 13,
          alignItems: "center",
          color: C.blue,
          fontSize: 20,
        }}
      >
        <Tag color={C.blue}>
          <GitBranch size={17} /> Create or adopt a worktree
        </Tag>
        <ArrowUpRight size={22} />
      </div>
      <Footer>See every checkout—and exactly what it depends on.</Footer>
    </SceneFrame>
  );
};
