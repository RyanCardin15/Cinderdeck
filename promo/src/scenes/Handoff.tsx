import { Interactive, interpolate, useCurrentFrame } from "remotion";
import {
  ArrowDownToLine,
  Braces,
  Check,
  FileText,
  Film,
  FolderArchive,
  GitCompareArrows,
  Image,
  Radio,
  Terminal,
} from "lucide-react";
import {
  AppWindow,
  C,
  clamp,
  ease,
  enter,
  FlowPath,
  Footer,
  Heading,
  mono,
  SceneFrame,
  Tag,
} from "../design";
import { ShopPreview } from "./Recordings";

const EvidenceFile = ({
  icon: Icon,
  name,
  detail,
  color,
  top,
  delay,
}: {
  icon: typeof Film;
  name: string;
  detail: string;
  color: string;
  top: number;
  delay: number;
}) => {
  const f = useCurrentFrame();
  return (
    <div
      style={{
        position: "absolute",
        left: 1045,
        top,
        width: 690,
        height: 84,
        padding: "0 23px",
        boxSizing: "border-box",
        display: "flex",
        alignItems: "center",
        gap: 20,
        borderRadius: 11,
        border: `1px solid ${color}35`,
        background: "#1b2029",
        opacity: enter(f, delay),
        translate: `${(1 - enter(f, delay)) * 70}px 0px`,
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 9,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: `${color}12`,
        }}
      >
        <Icon size={25} color={color} />
      </div>
      <div>
        <div style={{ fontSize: 22, fontWeight: 550 }}>{name}</div>
        <div style={{ fontSize: 16, color: C.muted, marginTop: 6 }}>
          {detail}
        </div>
      </div>
      <Check size={23} color={color} style={{ marginLeft: "auto" }} />
    </div>
  );
};
export const Handoff = () => {
  const f = useCurrentFrame();
  return (
    <SceneFrame number="07" label="EVIDENCE, READY TO SHARE" accent={C.purple}>
      <Heading
        eyebrow="A RECORDING YOUR AGENT CAN INVESTIGATE"
        sub="From a screen, a window, or headless Chromium—to a complete evidence bundle."
      >
        Give your agent{" "}
        <span style={{ color: C.purple }}>the full picture.</span>
      </Heading>
      <svg width="1920" height="1080" style={{ position: "absolute" }}>
        <FlowPath
          d="M842 614 H939 Q985 614 985 426 H1045"
          color={C.purple}
          delay={41}
        />
        <FlowPath
          d="M842 614 H939 Q985 614 985 622 H1045"
          color={C.orange}
          delay={58}
        />
        <FlowPath
          d="M842 614 H939 Q985 614 985 818 H1045"
          color={C.green}
          delay={74}
        />
      </svg>
      <Interactive.Div
        name="Headless browser recording"
        style={{
          position: "absolute",
          left: 116,
          top: 373,
          width: 726,
          opacity: interpolate(f, [10, 35], [0, 1], clamp),
          translate: interpolate(f, [10, 50], ["-70px 0px", "0px 0px"], {
            ...clamp,
            easing: ease,
          }),
        }}
      >
        <AppWindow
          title="Browser recording"
          toolbar={
            <Tag small color={C.purple}>
              HEADLESS
            </Tag>
          }
        >
          <div style={{ padding: 16, background: "#0c1017" }}>
            <div style={{ height: 273, borderRadius: 9, overflow: "hidden" }}>
              <ShopPreview compact error />
            </div>
            <div
              style={{
                display: "flex",
                gap: 7,
                alignItems: "center",
                fontFamily: mono,
                fontSize: 15,
                color: C.red,
                padding: "15px 4px 6px",
              }}
            >
              <span>00:08.420</span>
              <span style={{ marginLeft: "auto", color: C.muted }}>
                Console + network captured
              </span>
            </div>
          </div>
        </AppWindow>
        <div
          style={{
            marginTop: 21,
            border: `1px solid ${C.line}`,
            background: "#131821",
            borderRadius: 12,
            padding: "18px 21px",
          }}
        >
          <div
            style={{
              display: "flex",
              gap: 11,
              alignItems: "center",
              fontFamily: mono,
              fontSize: 18,
              color: C.purple,
            }}
          >
            <Terminal size={20} />
            repro_frame
            <span style={{ marginLeft: "auto", fontSize: 14, color: C.green }}>
              MCP TOOL
            </span>
          </div>
          <div
            style={{
              fontFamily: mono,
              fontSize: 17,
              color: C.muted,
              marginTop: 13,
            }}
          >
            {'{ "at": "first_error" }'}
          </div>
          <div
            style={{
              fontSize: 18,
              marginTop: 15,
              opacity: enter(f, 75),
              color: C.text,
            }}
          >
            Returns the frame, nearby logs, and markers.
          </div>
        </div>
      </Interactive.Div>
      <div
        style={{
          position: "absolute",
          left: 1045,
          top: 354,
          display: "flex",
          gap: 12,
          alignItems: "center",
          fontSize: 22,
          color: C.purple,
          opacity: enter(f, 32),
        }}
      >
        <FolderArchive size={25} /> checkout-regression.zip{" "}
        <span style={{ marginLeft: 52, color: C.muted, fontSize: 15 }}>
          EXPORT BUNDLE
        </span>
      </div>
      <EvidenceFile
        icon={Film}
        name="recording.mp4"
        detail="The complete video"
        color={C.purple}
        top={393}
        delay={39}
      />
      <EvidenceFile
        icon={FileText}
        name="recording.log"
        detail="Timestamped workspace + browser output"
        color={C.orange}
        top={491}
        delay={54}
      />
      <EvidenceFile
        icon={Image}
        name="frames/"
        detail="First error, failed checks, final frame"
        color={C.blue}
        top={589}
        delay={69}
      />
      <EvidenceFile
        icon={GitCompareArrows}
        name="git/"
        detail="Uncommitted diffs from recording start"
        color={C.green}
        top={687}
        delay={84}
      />
      <EvidenceFile
        icon={Braces}
        name="README.md + repro.json"
        detail="Readable summary + structured context"
        color={C.amber}
        top={785}
        delay={99}
      />
      <div
        style={{
          position: "absolute",
          left: 1118,
          top: 902,
          fontSize: 20,
          display: "flex",
          alignItems: "center",
          gap: 12,
          color: C.green,
          opacity: enter(f, 132),
        }}
      >
        <ArrowDownToLine size={22} /> Include the evidence. Make the next step
        clear.
      </div>
      <Footer>
        <Radio size={22} color={C.purple} /> Capture. Inspect. Export. Available
        through MCP and CLI.
      </Footer>
    </SceneFrame>
  );
};
