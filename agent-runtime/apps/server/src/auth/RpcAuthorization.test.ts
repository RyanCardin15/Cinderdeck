import { OWNERSHIP_METHODS } from "@cinderdeck/contracts/deckhand/ownershipRpc";
import {
  AuthReviewWriteScope,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  WS_METHODS,
  WsRpcGroup,
} from "@cinderdeck/contracts";
import { HISTORY_IMPORT_METHODS } from "@cinderdeck/contracts/deckhand/historyImportRpc";
import { OWNED_PREVIEW_METHODS } from "@cinderdeck/contracts/deckhand/ownedPreviewRpc";
import { DECKHAND_METHODS } from "@cinderdeck/contracts/deckhand/rpc";
import { describe, expect, it } from "@effect/vitest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("requires operation authority for ownership submission and recovery", () => {
    for (const method of [OWNERSHIP_METHODS.submit, OWNERSHIP_METHODS.get])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    for (const method of [OWNERSHIP_METHODS.preview, OWNERSHIP_METHODS.list])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
  });
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("separates managed lane launch authority from session and receipt observation", () => {
    expect(requiredScopeForRpcMethod(DECKHAND_METHODS.launch)).toBe(AuthOrchestrationOperateScope);
    expect(requiredScopeForRpcMethod(DECKHAND_METHODS.reviewConfirm)).toBe(
      AuthOrchestrationOperateScope,
    );
    for (const method of [
      DECKHAND_METHODS.sessions,
      DECKHAND_METHODS.contextPullRequests,
      DECKHAND_METHODS.launchGet,
      DECKHAND_METHODS.launchOptions,
      DECKHAND_METHODS.reviewPreview,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("requires permission to operate on a thread before uploading feedback", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.providerUploadFeedback)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("requires write access to import agent session history", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsScan)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.agentSessionsImport)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates ACP Registry discovery from provisioning", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverSearchAcpRegistry)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverPrepareAcpRegistryAgent)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverUninstallAcpRegistryManagedBinary)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverAcceptAcpRegistryUrlAuth)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverListAcpRegistrySessions)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverImportAcpRegistrySession)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverLogoutAcpRegistry)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("reads the reviewer menu under the same scope as the pull request it belongs to", () => {
    // The candidate list is a read like the detail beside it, and asking somebody for a review is
    // a write like every other pull request operation.
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsChecks)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsReviewerCandidates)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsDetail),
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.pullRequestsRequestReviewers)).toBe(
      requiredScopeForRpcMethod(WS_METHODS.pullRequestsComment),
    );
  });

  it("keeps local history archives outside standard provider authority", () => {
    for (const method of [HISTORY_IMPORT_METHODS.import, HISTORY_IMPORT_METHODS.remove]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthAccessWriteScope);
    }
    for (const method of [
      HISTORY_IMPORT_METHODS.get,
      HISTORY_IMPORT_METHODS.list,
      HISTORY_IMPORT_METHODS.threads,
      HISTORY_IMPORT_METHODS.messages,
      HISTORY_IMPORT_METHODS.messageText,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthAccessReadScope);
    }
    expect(AuthStandardClientScopes).not.toContain(AuthAccessReadScope);
    expect(AuthStandardClientScopes).not.toContain(AuthAccessWriteScope);
  });

  it("requires operation authority to begin preview capture", () => {
    expect(requiredScopeForRpcMethod(OWNED_PREVIEW_METHODS.intent)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(OWNED_PREVIEW_METHODS.get)).toBe(AuthOrchestrationReadScope);
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

it("requires review scope for GitHub reviews and operate scope for saved queries and stars", async () => {
  const { requiredScopeForGitHubWorkspace } = await import("./RpcAuthorization.ts");
  expect(requiredScopeForGitHubWorkspace({ action: "review" })).toBe(AuthReviewWriteScope);
  expect(requiredScopeForGitHubWorkspace({ action: "star" })).toBe(AuthOrchestrationOperateScope);
  expect(requiredScopeForGitHubWorkspace({ action: "preferences" })).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForGitHubWorkspace({ action: "select" })).toBe(AuthOrchestrationOperateScope);
});
