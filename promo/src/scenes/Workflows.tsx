import { Interactive, interpolate, useCurrentFrame } from "remotion";
import {
  Check,
  ChevronRight,
  Clock3,
  Code2,
  Hammer,
  Play,
  TestTube2,
} from "lucide-react";
import {
  C,
  clamp,
  Dot,
  ease,
  enter,
  Footer,
  Heading,
  mono,
  SceneFrame,
  Tag,
} from "../design";

const steps = [
  {
    name: "Lint",
    command: "npm run lint",
    icon: Code2,
    start: 29,
    end: 54,
    time: "0.8s",
  },
  {
    name: "Start API",
    command: "wait for readiness",
    icon: Play,
    start: 54,
    end: 82,
    time: "1.1s",
  },
  {
    name: "Test",
    command: "npm test",
    icon: TestTube2,
    start: 82,
    end: 117,
    time: "2.4s",
  },
  {
    name: "Build",
    command: "npm run build",
    icon: Hammer,
    start: 117,
    end: 146,
    time: "1.7s",
  },
];
export const Workflows = () => {
  const f = useCurrentFrame();
  return (
    <SceneFrame number="05" label="TASKS & WORKFLOWS" accent={C.green}>
      <Heading
        eyebrow="TURN COMMANDS INTO A REPEATABLE PROCESS"
        sub="Order the steps. Wait for readiness. Keep the result."
      >
        From command to <span style={{ color: C.green }}>confidence.</span>
      </Heading>
      <Interactive.Div
        name="Verification workflow"
        style={{
          position: "absolute",
          left: 96,
          right: 96,
          top: 374,
          opacity: interpolate(f, [8, 25], [0, 1], clamp),
          translate: interpolate(f, [8, 40], ["0px 70px", "0px 0px"], {
            ...clamp,
            easing: ease,
          }),
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 15,
            fontSize: 25,
            marginBottom: 30,
          }}
        >
          <span style={{ color: C.orange }}>◆</span>
          <b>Verify changes</b>
          <span
            style={{
              fontFamily: mono,
              fontSize: 17,
              color: C.muted,
              marginLeft: 12,
            }}
          >
            orbit / feature/search
          </span>
          <span style={{ marginLeft: "auto" }}>
            <Tag color={f > 146 ? C.green : C.orange}>
              <Dot color={f > 146 ? C.green : C.orange} />
              {f > 146 ? "Succeeded" : "Running"}
            </Tag>
          </span>
        </div>
        <div style={{ position: "relative", display: "flex", gap: 38 }}>
          <div
            style={{
              position: "absolute",
              left: 120,
              right: 120,
              top: 105,
              height: 2,
              background: C.line,
            }}
          />
          <div
            style={{
              position: "absolute",
              left: 120,
              width: interpolate(f, [29, 146], [0, 1480], clamp),
              top: 105,
              height: 2,
              background: C.green,
              boxShadow: "0 0 12px #74dfba55",
            }}
          />
          {steps.map((s, i) => {
            const Icon = s.icon,
              done = f >= s.end,
              active = f >= s.start && !done;
            return (
              <div
                key={s.name}
                style={{
                  width: 403,
                  height: 231,
                  padding: 26,
                  boxSizing: "border-box",
                  borderRadius: 17,
                  background: active ? "#1b292a" : "#171c24",
                  border: `1px solid ${done ? C.green + "60" : active ? C.orange : C.line}`,
                  position: "relative",
                  opacity: enter(f, 12 + i * 6),
                  translate: `0px ${(1 - enter(f, 12 + i * 6)) * 50}px`,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    color: done ? C.green : active ? C.orange : C.muted,
                  }}
                >
                  <span style={{ fontFamily: mono, fontSize: 15 }}>
                    0{i + 1}
                  </span>
                  {done ? <Check size={26} /> : <Icon size={26} />}
                </div>
                <div style={{ fontSize: 34, fontWeight: 600, marginTop: 21 }}>
                  {s.name}
                </div>
                <div
                  style={{
                    fontFamily: mono,
                    fontSize: 17,
                    color: C.muted,
                    marginTop: 14,
                  }}
                >
                  {s.command}
                </div>
                <div
                  style={{
                    position: "absolute",
                    bottom: 23,
                    left: 26,
                    right: 26,
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 16,
                    color: done ? C.green : active ? C.orange : C.muted,
                  }}
                >
                  <span>
                    {done ? "Passed" : active ? "Running…" : "Queued"}
                  </span>
                  <span>{done ? s.time : ""}</span>
                </div>
                {i < 3 && (
                  <ChevronRight
                    size={23}
                    style={{
                      position: "absolute",
                      right: -33,
                      top: 94,
                      color: C.muted,
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 30, display: "flex", gap: 24 }}>
          <div
            style={{
              flex: 1,
              padding: "23px 28px",
              borderRadius: 13,
              border: `1px solid ${C.line}`,
              background: "#10141b",
              fontFamily: mono,
              fontSize: 19,
              lineHeight: 1.8,
            }}
          >
            <div style={{ color: C.muted }}>
              $ cinderdeck workspace workflow orbit/feature/search verify --wait
            </div>
            <div
              style={{
                color: f > 146 ? C.green : C.muted,
                opacity: enter(f, 48),
              }}
            >
              {f > 146
                ? "✓ 4 steps completed · exit 0"
                : f > 117
                  ? "› Build production bundle…"
                  : f > 82
                    ? "› Run integration tests…"
                    : f > 54
                      ? "› API ready. Starting tests…"
                      : "› Linting source files…"}
            </div>
          </div>
          <div
            style={{
              width: 310,
              padding: 23,
              borderRadius: 13,
              border: `1px solid ${C.line}`,
              background: "#191f27",
              opacity: enter(f, 128),
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 20,
              }}
            >
              <Clock3 size={21} color={C.green} /> Run history
            </div>
            <div style={{ fontSize: 18, color: C.muted, marginTop: 17 }}>
              Logs. Durations. Exit codes.
            </div>
            <div style={{ fontSize: 17, color: C.green, marginTop: 12 }}>
              Saved across relaunches.
            </div>
          </div>
        </div>
      </Interactive.Div>
      <Footer>See each step’s output. Rerun when you’re ready.</Footer>
    </SceneFrame>
  );
};
