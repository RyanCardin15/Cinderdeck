import { EnvironmentId } from "@t3tools/contracts";
import type { IntegrationView } from "@t3tools/contracts/deckhand/rpc";
import { expect, it } from "vite-plus/test";
import {
  canChooseConnectedWorkspace,
  connectedWorkspaceDestination,
  connectedWorkspaceSearch,
  presentCinderdeckConnection,
  unresolvedIntegrationOperations,
} from "./connectionPresentation";

it("explains every connection state with an actionable recovery", () => {
  for (const state of [
    "connecting",
    "connected",
    "reconnecting",
    "unavailable",
    "incompatible",
    "identity_changed",
    "unauthorized",
    "unsupported",
  ] as const) {
    const presentation = presentCinderdeckConnection({ state });
    expect(presentation.title.length).toBeGreaterThan(5);
    expect(presentation.detail.length).toBeGreaterThan(30);
  }
  expect(presentCinderdeckConnection(null).title).toBe("Checking Cinderdeck");
});
it("does not choose a missing snapshot and does not invent pending operations", () => {
  expect(canChooseConnectedWorkspace(null, undefined)).toBe(false);
  expect(unresolvedIntegrationOperations([])).toEqual([]);
});

it("routes primary and lane contexts under their real base with saved identity pins", () => {
  const primary: IntegrationView["resources"][number] = {
    workspaceID: "payment",
    generation: 2,
    revision: "r1",
    available: true,
    workspace: {
      id: "payment",
      name: "Payment",
      file: "/fixture/payment.toml",
      state: "ready",
      definitionChanged: false,
      issues: [],
      services: [],
      repos: [],
    },
  };
  const lane: IntegrationView["resources"][number] = {
    ...primary,
    workspaceID: "lane-api",
    generation: 4,
    workspace: {
      ...primary.workspace!,
      id: "lane-api",
      lane: {
        sourceStackID: "payment",
        name: "verify/api",
        createdAt: "2026-10-03T00:00:00Z",
        directory: "/fixture/lane",
        ports: {},
      },
    },
  };
  const environmentId = EnvironmentId.make("computer");
  const primaryDestination = connectedWorkspaceDestination(environmentId, "installation", primary)!;
  expect(connectedWorkspaceSearch(primaryDestination)).toEqual({
    tab: "services",
    environment: "computer",
    workspace: "payment",
    context: "payment",
    expectedInstallationID: "installation",
    expectedGeneration: 2,
  });
  const laneDestination = connectedWorkspaceDestination(environmentId, "installation", lane)!;
  expect(connectedWorkspaceSearch(laneDestination)).toEqual({
    tab: "services",
    environment: "computer",
    workspace: "payment",
    context: "lane-api",
    expectedInstallationID: "installation",
    expectedGeneration: 4,
  });
  expect(
    connectedWorkspaceSearch(
      connectedWorkspaceDestination(environmentId, "installation", lane, 3)!,
    ),
  ).toMatchObject({ context: "lane-api", expectedGeneration: 3 });
});
