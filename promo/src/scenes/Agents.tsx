import {
  Img,
  Interactive,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import {
  Bot,
  Braces,
  Check,
  Code2,
  Command,
  Radio,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import {
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
  ToolCall,
} from "../design";

export const Agents = () => {
  const f = useCurrentFrame();
  const clients = [
    { name: "Codex", label: "OpenAI", icon: Command, y: 394, color: C.text },
    {
      name: "Claude Code",
      label: "Anthropic",
      icon: Bot,
      y: 530,
      color: C.orange,
    },
    { name: "Cursor", label: "Editor", icon: Code2, y: 666, color: C.blue },
    {
      name: "VS Code Copilot",
      label: "Editor",
      icon: Braces,
      y: 802,
      color: C.purple,
    },
  ];
  return (
    <SceneFrame number="04" label="MCP CONNECTIVITY" accent={C.green}>
      <Heading
        eyebrow="YOUR AGENTS CAN OPERATE THE DECK"
        sub="Discover workspaces, create lanes, start services, run checks, and review recordings."
      >
        Your agents. <span style={{ color: C.green }}>Real control.</span>
      </Heading>
      <svg width="1920" height="1080" style={{ position: "absolute" }}>
        {clients.map((c, i) => (
          <FlowPath
            key={c.name}
            d={`M499 ${c.y + 43} C650 ${c.y + 43} 620 657 792 657`}
            color={c.color}
            delay={25 + i * 11}
            travel={80}
          />
        ))}
        <FlowPath d="M1000 657 H1138" color={C.orange} delay={40} travel={50} />
      </svg>
      {clients.map((c, i) => {
        const Icon = c.icon;
        return (
          <div
            key={c.name}
            style={{
              position: "absolute",
              left: 125,
              top: c.y,
              width: 373,
              height: 88,
              padding: "0 25px",
              boxSizing: "border-box",
              border: `1px solid ${C.line}`,
              borderRadius: 14,
              background: "#191e26",
              display: "flex",
              alignItems: "center",
              gap: 18,
              opacity: enter(f, 14 + i * 10),
              translate: `${(1 - enter(f, 14 + i * 10)) * -50}px 0px`,
            }}
          >
            <Icon size={29} color={c.color} />
            <div>
              <div style={{ fontSize: 23, fontWeight: 550 }}>{c.name}</div>
              <div style={{ fontSize: 14, color: C.muted, marginTop: 6 }}>
                {c.label}
              </div>
            </div>
            <span style={{ marginLeft: "auto" }}>
              <Dot color={f > 70 + i * 10 ? C.green : C.muted} />
            </span>
          </div>
        );
      })}
      <Interactive.Div
        name="MCP connection hub"
        style={{
          position: "absolute",
          left: 716,
          top: 460,
          width: 360,
          height: 365,
          opacity: interpolate(f, [15, 42], [0, 1], clamp),
          scale: interpolate(f, [15, 65], [0.7, 1], { ...clamp, easing: ease }),
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 8,
            borderRadius: "50%",
            border: "1px solid #ff6b2c26",
            boxShadow: "0 0 90px #ff6b2c0b",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 37,
            borderRadius: "50%",
            border: "1px dashed #ff6b2c35",
            rotate: `${f * 0.16}deg`,
          }}
        />
        <Img
          src={staticFile("cinderdeck-icon.png")}
          style={{
            position: "absolute",
            left: 70,
            top: 42,
            width: 220,
            height: 220,
            filter: "drop-shadow(0 20px 25px #0009)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 76,
            top: 279,
            fontFamily: mono,
            fontSize: 20,
            color: C.orange,
            display: "flex",
            alignItems: "center",
            gap: 11,
          }}
        >
          <Radio size={21} /> LOCAL MCP + CLI
        </div>
      </Interactive.Div>
      <Interactive.Div
        name="Agent tool call transcript"
        style={{
          position: "absolute",
          left: 1138,
          top: 377,
          width: 654,
          border: `1px solid ${C.line}`,
          borderRadius: 17,
          background: "#171c24",
          padding: 25,
          opacity: interpolate(f, [25, 50], [0, 1], clamp),
          translate: interpolate(f, [25, 65], ["60px 0px", "0px 0px"], {
            ...clamp,
            easing: ease,
          }),
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 11,
            alignItems: "center",
            fontSize: 19,
            marginBottom: 20,
          }}
        >
          <Terminal size={21} color={C.orange} />
          Cinderdeck tools
          <span style={{ marginLeft: "auto", fontSize: 14, color: C.green }}>
            ● CONNECTED
          </span>
        </div>
        <div style={{ opacity: enter(f, 51) }}>
          <ToolCall name="list_workspaces" args={'{ "detail": false }'} />
        </div>
        <div style={{ marginTop: 11, opacity: enter(f, 85) }}>
          <ToolCall
            name="create_lane"
            args={'{ "workspace": "orbit", "branch": "feature/search" }'}
            status={f > 124 ? "Complete" : "Running…"}
            color={f > 124 ? C.green : C.orange}
          />
        </div>
        <div style={{ marginTop: 11, opacity: enter(f, 134) }}>
          <ToolCall
            name="run_workspace_workflow"
            args={
              '{ "workspace": "orbit/feature/search", "workflow": "verify" }'
            }
            status={f > 184 ? "Complete" : "Running…"}
            color={f > 184 ? C.green : C.orange}
          />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: 17,
            color: C.green,
            marginTop: 22,
            opacity: enter(f, 192),
          }}
        >
          <Check size={20} /> Results and logs return to your agent.
        </div>
      </Interactive.Div>
      <div
        style={{
          position: "absolute",
          left: 710,
          bottom: 94,
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 17,
          color: C.muted,
          opacity: enter(f, 150),
        }}
      >
        <ShieldCheck size={20} color={C.green} /> Agent identity & visible
        workspace leases
      </div>
      <Footer>
        The same controls—from the app, your terminal, or your coding agent.
      </Footer>
    </SceneFrame>
  );
};
