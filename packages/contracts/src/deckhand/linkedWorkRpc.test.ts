import { expect, it } from "vite-plus/test";
import { ThreadId } from "../baseSchemas.ts";
import { parseLinkedWorkURL, linkedWorkDesktopURL } from "./linkedWorkRpc.ts";
const target = {
  installation: "install",
  workspace: "lane/a",
  generation: 7,
  session: "session",
  thread: ThreadId.make("thread"),
  environment: "environment",
};
it("round-trips opaque identity into its exact desktop channel", () => {
  const dev = linkedWorkDesktopURL(target, true);
  expect(parseLinkedWorkURL(dev, true)).toEqual(target);
  expect(parseLinkedWorkURL(dev, false)).toBeNull();
});
it("refuses duplicated identity, credentials, executable paths and extra directives", () => {
  const valid = linkedWorkDesktopURL(target, false);
  for (const candidate of [
    valid + "&workspace=other",
    valid + "&file=/tmp/project",
    valid + "#execute",
    valid.replace("//app/", "//user@app/"),
    valid.replace("/linked-work?", "/linked-work/run?"),
    valid.replace("generation=7", "generation=0"),
    valid.replace("workspace=lane%2Fa", "workspace=%00"),
  ])
    expect(parseLinkedWorkURL(candidate, false)).toBeNull();
});
