import { Interactive, interpolate, useCurrentFrame } from "remotion";
import {
  ArrowUpRight,
  Box,
  Database,
  GitBranch,
  Globe,
  Play,
  Square,
  Terminal,
  Workflow,
  Zap,
} from "lucide-react";
import {
  AppWindow,
  C,
  CheckIcon,
  clamp,
  Cursor,
  Dot,
  ease,
  enter,
  Footer,
  Heading,
  mono,
  SceneFrame,
  Sidebar,
  Tag,
} from "../design";

const services = [
  {
    name: "web",
    cmd: "npm run dev",
    port: 3000,
    icon: Globe,
    color: C.blue,
    at: 91,
  },
  {
    name: "api",
    cmd: "uvicorn app:server",
    port: 4000,
    icon: Box,
    color: C.green,
    at: 75,
  },
  {
    name: "worker",
    cmd: "npm run worker",
    port: null,
    icon: Zap,
    color: C.purple,
    at: 110,
  },
  {
    name: "database",
    cmd: "postgres -D ./data",
    port: 5432,
    icon: Database,
    color: C.orange,
    at: 59,
  },
];
const logs = [
  ["database", "Ready to accept connections", 61],
  ["api", "Listening on localhost:4000", 79],
  ["web", "Ready on localhost:3000", 95],
  ["worker", "Waiting for jobs", 113],
  ["api", "GET /health 200 · 4ms", 143],
  ["web", "GET / 200 · 12ms", 166],
  ["worker", "Job completed · order.created", 189],
] as const;
export const Workspaces = () => {
  const f = useCurrentFrame();
  return (
    <SceneFrame number="02" label="WORKSPACES">
      <Heading
        eyebrow="BRING YOUR WHOLE PROJECT"
        sub="Services, repositories, tasks, and workflows. One place to run them."
      >
        Every moving part.{" "}
        <span style={{ color: C.orange }}>One workspace.</span>
      </Heading>
      <Interactive.Div
        name="Workspace interface"
        style={{
          position: "absolute",
          left: 174,
          top: 355,
          width: 1572,
          opacity: interpolate(f, [9, 32], [0, 1], clamp),
          translate: interpolate(f, [9, 55], ["0px 90px", "0px 0px"], {
            ...clamp,
            easing: ease,
          }),
          scale: interpolate(f, [20, 235], [0.985, 1.015], clamp),
        }}
      >
        <AppWindow
          title="Cinderdeck — Workspaces"
          toolbar={
            <Tag small>
              <Dot size={6} /> Local
            </Tag>
          }
        >
          <div style={{ display: "flex", height: 568 }}>
            <Sidebar />
            <div style={{ padding: "24px 30px", flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 15 }}>
                <div style={{ fontSize: 32, fontWeight: 600 }}>Orbit</div>
                <Tag small color={f > 113 ? C.green : C.muted}>
                  {f > 113 ? "4 services ready" : "Ready to start"}
                </Tag>
                <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
                  <div
                    style={{
                      padding: "9px 14px",
                      background: "#ffffff07",
                      border: `1px solid ${C.line}`,
                      borderRadius: 8,
                      fontSize: 16,
                      display: "flex",
                      gap: 8,
                    }}
                  >
                    <GitBranch size={18} /> Lanes
                  </div>
                  <div
                    style={{
                      padding: "9px 14px",
                      background: f > 50 ? "#ffffff07" : C.orange,
                      color: f > 50 ? C.text : C.bg,
                      borderRadius: 8,
                      fontSize: 16,
                      fontWeight: 600,
                      display: "flex",
                      gap: 8,
                    }}
                  >
                    {f > 50 ? <Square size={17} /> : <Play size={17} />}
                    {f > 50 ? "Stop" : "Start services"}
                  </div>
                </div>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4,1fr)",
                  gap: 14,
                  marginTop: 23,
                }}
              >
                {services.map((s, i) => {
                  const ready = f > s.at;
                  const Icon = s.icon;
                  return (
                    <div
                      key={s.name}
                      style={{
                        background: "#191f28",
                        border: `1px solid ${ready ? s.color + "55" : C.line}`,
                        borderRadius: 13,
                        padding: 19,
                        opacity: enter(f, 16 + i * 6),
                        translate: `0px ${(1 - enter(f, 16 + i * 6)) * 18}px`,
                        boxShadow: ready ? `0 0 25px ${s.color}06` : "none",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        <Icon size={24} color={s.color} />
                        <b style={{ fontSize: 21 }}>{s.name}</b>
                        <span style={{ marginLeft: "auto" }}>
                          <Dot
                            color={
                              ready ? C.green : f > 50 ? C.orange : C.muted
                            }
                          />
                        </span>
                      </div>
                      <div
                        style={{
                          fontFamily: mono,
                          fontSize: 14,
                          color: C.muted,
                          marginTop: 19,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {s.cmd}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginTop: 24,
                          fontSize: 16,
                          color: ready ? C.green : C.muted,
                        }}
                      >
                        <span>
                          {ready ? "Ready" : f > 50 ? "Starting…" : "Stopped"}
                        </span>
                        <span style={{ fontFamily: mono, color: s.color }}>
                          {s.port ? `:${s.port}` : "jobs"}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div
                style={{
                  marginTop: 20,
                  display: "flex",
                  gap: 14,
                  alignItems: "center",
                  fontSize: 16,
                  color: C.muted,
                }}
              >
                <GitBranch size={18} />
                <span>web / main</span>
                <span style={{ color: C.line }}>│</span>
                <span>api / main</span>
                <span
                  style={{
                    marginLeft: "auto",
                    display: "flex",
                    gap: 9,
                    alignItems: "center",
                  }}
                >
                  <Workflow size={18} /> verify · 4 steps
                </span>
              </div>
              <div
                style={{
                  marginTop: 20,
                  border: `1px solid ${C.line}`,
                  background: "#0c1016",
                  borderRadius: 11,
                  overflow: "hidden",
                  height: 225,
                }}
              >
                <div
                  style={{
                    height: 38,
                    padding: "0 15px",
                    display: "flex",
                    gap: 9,
                    alignItems: "center",
                    background: "#ffffff04",
                    fontSize: 14,
                    color: C.muted,
                  }}
                >
                  <Terminal size={15} /> All services
                  <span style={{ marginLeft: "auto", color: C.orange }}>
                    ● LIVE OUTPUT
                  </span>
                </div>
                <div
                  style={{
                    padding: "9px 17px",
                    fontFamily: mono,
                    fontSize: 15,
                    lineHeight: "25px",
                  }}
                >
                  {logs.map(([s, t, at], i) => (
                    <div
                      key={t}
                      style={{
                        opacity: enter(f, at, 9),
                        display: "flex",
                        gap: 19,
                      }}
                    >
                      <span style={{ color: "#626d7c" }}>14:32:0{i}</span>
                      <span
                        style={{
                          width: 88,
                          color: services.find((x) => x.name === s)?.color,
                        }}
                      >
                        {s}
                      </span>
                      <span style={{ color: "#d0d6df" }}>{t}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </AppWindow>
        <Cursor
          x={interpolate(f, [25, 47], [1450, 1455], clamp)}
          y={interpolate(f, [25, 47], [230, 114], { ...clamp, easing: ease })}
          click={f > 49 && f < 66 ? (f - 49) / 17 : 0}
        />
      </Interactive.Div>
      <div
        style={{
          position: "absolute",
          right: 85,
          top: 797,
          opacity: enter(f, 155),
          translate: `${(1 - enter(f, 155)) * 30}px 0px`,
          boxShadow: "0 15px 55px #0009",
          background: "#222a33",
          border: `1px solid ${C.green}55`,
          borderRadius: 14,
          padding: "17px 23px",
          display: "flex",
          alignItems: "center",
          gap: 14,
          fontSize: 20,
        }}
      >
        <CheckIcon /> Your environment is ready{" "}
        <ArrowUpRight size={21} color={C.green} />
      </div>
      <Footer>Your folders. Your commands. Your choice of tools.</Footer>
    </SceneFrame>
  );
};
