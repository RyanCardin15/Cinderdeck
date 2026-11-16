import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentProject } from "@cinderdeck/client-runtime/state/models";
import type { EnvironmentConnectionPhase } from "@cinderdeck/client-runtime/connection";
import { EnvironmentId } from "@cinderdeck/contracts";
import { pullRequestFallbackEnvironment } from "./pullRequestEnvironmentFallback";

const project = (environmentId: string, id: string, canonicalKey: string) =>
  ({
    environmentId,
    id,
    repositoryIdentity: { canonicalKey },
  }) as unknown as EnvironmentProject;

const projects = [
  project("laptop", "cinderdeck", "github.com/pingdotgg/cinderdeck"),
  project("desktop", "other", "github.com/pingdotgg/other"),
  project("server", "cinderdeck-copy", "github.com/pingdotgg/cinderdeck"),
];
const target = {
  environmentId: "laptop",
  projectId: "cinderdeck",
  repository: "pingdotgg/cinderdeck",
  host: "github.com",
};
const environment = (
  environmentId: string,
  connectionState: EnvironmentConnectionPhase = "connected",
  isEnabled = true,
) => ({ environmentId: EnvironmentId.make(environmentId), connectionState, isEnabled });

describe("pullRequestFallbackEnvironment", () => {
  it("moves to a connected copy of the repository when the original is down", () => {
    expect(
      pullRequestFallbackEnvironment(target, projects, [
        environment("desktop"),
        environment("server"),
      ]),
    ).toEqual({ environmentId: "server", projectId: "cinderdeck-copy" });
  });

  it("stays put while the original is connected or nothing else holds the repository", () => {
    expect(
      pullRequestFallbackEnvironment(target, projects, [
        environment("laptop"),
        environment("server"),
      ]),
    ).toBe(null);
    expect(pullRequestFallbackEnvironment(target, projects, [environment("desktop")])).toBe(null);
  });

  it("derives the host from the original project when the route has none", () => {
    const { host: _host, ...hostless } = target;
    expect(pullRequestFallbackEnvironment(hostless, projects, [environment("server")])).toEqual({
      environmentId: "server",
      projectId: "cinderdeck-copy",
    });
  });
});
