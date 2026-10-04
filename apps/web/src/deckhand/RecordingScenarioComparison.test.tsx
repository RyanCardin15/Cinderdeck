import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { VerificationOverview } from "@t3tools/contracts/deckhand/verificationRpc";
import { RecordingScenarioComparison } from "./RecordingScenarioComparison";
const commands = vi.hoisted(() => ({ save: vi.fn(), remove: vi.fn(), media: vi.fn() }));
vi.mock("./verificationState", () => ({
  saveVerificationScenario: "save",
  removeVerificationScenario: "remove",
}));
vi.mock("./recordingState", () => ({ recordingMedia: "media" }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (name: "save" | "remove" | "media") => commands[name],
}));
vi.mock("../state/environments", () => ({
  useEnvironmentHttpBaseUrl: () => "http://fixture.test",
}));
const environmentId = Schema.decodeUnknownSync(EnvironmentId)("fixture");
const reference = Schema.decodeUnknownSync(PullRequestRef)({
  projectId: "project",
  repository: "cardin/app",
  number: 7,
});
const view = Schema.decodeUnknownSync(VerificationOverview)({
  head: "after-head",
  repositoryKeys: ["github.com/cardin/app"],
  observedAt: "2026-10-03T00:02:00Z",
  contexts: [],
  sessions: [],
  evidence: ["before", "after"].map((id, index) => ({
    artifactID: id,
    featureID: "feature",
    checkoutID: "checkout",
    context: { installationID: "native", workspaceID: "lane", generation: 1, recordingID: id },
    manifestHash: `hash-${id}`,
    linkedAtHead: "after-head",
    sourceState: index ? "source_match" : "stale",
    buildState: "unknown",
    reason: "Served build unknown.",
    recording: {
      id,
      title: index ? "Retry succeeds" : "Retry fails",
      state: "ready",
      createdAt: `2026-10-03T00:0${index}:00Z`,
      duration: 10,
      actor: "Deckhand",
      capture: "Window",
      primaryWorkspaceID: "lane",
      capturedWorkspaceIDs: ["lane"],
      capturedWorkspaceNames: ["App"],
      lineCount: 20,
      errorCount: index ? 0 : 2,
      warningCount: 0,
      playable: true,
      paused: false,
      controlAllowed: false,
      detail: null,
      checkOutcome: index ? "passed" : "failed",
      markers: [],
      repositories: [],
    },
  })),
});
const scenario = {
  id: "pair",
  title: "Payment retry",
  featureID: "feature",
  baselineArtifactID: "before",
  followupArtifactID: "after",
  baselineManifestHash: "hash-before",
  followupManifestHash: "hash-after",
  createdAt: "2026-10-03T00:02:00Z",
};

let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.clearAllMocks();
});
const text = (node: unknown): string =>
  typeof node === "string" ? node : Array.isArray(node) ? node.map(text).join("") : "";
function button(label: string) {
  return renderer.root.findAllByType("button").find((node) => text(node.children) === label)!;
}
function change(index: number, value: string) {
  renderer.root.findAllByType("select")[index]!.props.onChange({ target: { value } });
}
describe("recording scenario comparison", () => {
  it("creates a named pair and loads both exact saved videos, retaining detached evidence identity", async () => {
    commands.save.mockResolvedValue({ _tag: "Success", value: { ...view, scenarios: [scenario] } });
    commands.media.mockImplementation(({ input }: { input: { recordingID: string } }) =>
      Promise.resolve({ _tag: "Success", value: { path: `/media/${input.recordingID}` } }),
    );
    const changed = vi.fn(),
      open = vi.fn();
    const props = { environmentId, reference, view, onChange: changed, onOpen: open };
    await act(async () => {
      renderer = create(<RecordingScenarioComparison {...props} />);
    });
    act(() =>
      renderer.root.findByType("input").props.onChange({ target: { value: "Payment retry" } }),
    );
    act(() => change(0, "before:feature"));
    act(() => change(1, "after:feature"));
    await act(async () => button("Save comparison").props.onClick());
    expect(changed).toHaveBeenCalledOnce();
    expect(commands.save.mock.calls[0]?.[0].input).toMatchObject({
      title: "Payment retry",
      featureID: "feature",
      baselineArtifactID: "before",
      followupArtifactID: "after",
    });
    await act(async () =>
      renderer.update(
        <RecordingScenarioComparison {...props} view={{ ...view, scenarios: [scenario] }} />,
      ),
    );
    await act(async () => change(0, "pair"));
    expect(renderer.root.findAllByType("video").map((video) => video.props.src)).toEqual([
      "http://fixture.test/media/before",
      "http://fixture.test/media/after",
    ]);
    expect(
      renderer.root.findAllByType("dd").filter((node) => text(node.children) === "Unknown"),
    ).toHaveLength(2);
    expect(
      renderer.root
        .findAllByType("p")
        .some((node) => text(node.children).includes("video target remains unverified")),
    ).toBe(true);
    act(() =>
      renderer.root
        .findAllByType("button")
        .find((node) => text(node.children) === "Open timeline and logs")!
        .props.onClick(),
    );
    expect(open).toHaveBeenCalledWith(view.evidence[0]);
    await act(async () =>
      renderer.update(
        <RecordingScenarioComparison
          {...props}
          view={{ ...view, evidence: [view.evidence[1]!], scenarios: [scenario] }}
        />,
      ),
    );
    expect(
      renderer.root
        .findAllByType("p")
        .some((node) => text(node.children).includes("no longer attached")),
    ).toBe(true);
    expect(renderer.root.findAllByType("video").map((video) => video.props.src)).toEqual([
      "http://fixture.test/media/after",
    ]);
  });
  it("retries an uncertain save with the original scenario identity and immutable request", async () => {
    commands.save
      .mockRejectedValueOnce(new Error("Disconnected"))
      .mockResolvedValueOnce({ _tag: "Success", value: { ...view, scenarios: [scenario] } });
    await act(async () => {
      renderer = create(
        <RecordingScenarioComparison
          environmentId={environmentId}
          reference={reference}
          view={view}
          onChange={vi.fn()}
          onOpen={vi.fn()}
        />,
      );
    });
    act(() =>
      renderer.root.findByType("input").props.onChange({ target: { value: "Payment retry" } }),
    );
    act(() => change(0, "before:feature"));
    act(() => change(1, "after:feature"));
    await act(async () => button("Save comparison").props.onClick());
    expect(renderer.root.findByType("input").props.disabled).toBe(true);
    await act(async () => button("Retry saved request").props.onClick());
    expect(commands.save).toHaveBeenCalledTimes(2);
    expect(commands.save.mock.calls[1]?.[0].input).toEqual(commands.save.mock.calls[0]?.[0].input);
  });
});
