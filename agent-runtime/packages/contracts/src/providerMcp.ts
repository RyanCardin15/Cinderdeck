import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Connection state of one MCP server, normalized across providers.
 * `disabled` means the provider's own configuration turned the server off;
 * servers Cinderdeck turns off stay in their reported state and are marked
 * through `ProviderMcpPreferences` instead.
 */
export const ProviderMcpServerStatus = Schema.Literals([
  "connected",
  "needsAuth",
  "failed",
  "pending",
  "disabled",
]);
export type ProviderMcpServerStatus = typeof ProviderMcpServerStatus.Type;

export const ProviderMcpServerAuth = Schema.Literals(["oauth", "bearerToken", "notLoggedIn"]);
export type ProviderMcpServerAuth = typeof ProviderMcpServerAuth.Type;

export const ProviderMcpTool = Schema.Struct({
  name: TrimmedNonEmptyString,
  title: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  readOnly: Schema.optionalKey(Schema.Boolean),
  destructive: Schema.optionalKey(Schema.Boolean),
  /** Turned off in the provider's own configuration; Cinderdeck cannot turn it on. */
  disabledByProvider: Schema.optionalKey(Schema.Boolean),
});
export type ProviderMcpTool = typeof ProviderMcpTool.Type;

export const ProviderMcpServer = Schema.Struct({
  name: TrimmedNonEmptyString,
  title: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  /** Where the provider found the server, e.g. `user`, `project`, `plugin`, `claude.ai`. */
  source: Schema.optionalKey(Schema.String),
  /** Host of a remote server. Never includes credentials, path or query. */
  origin: Schema.optionalKey(Schema.String),
  status: ProviderMcpServerStatus,
  auth: Schema.optionalKey(ProviderMcpServerAuth),
  error: Schema.optionalKey(Schema.String),
  tools: Schema.Array(ProviderMcpTool),
});
export type ProviderMcpServer = typeof ProviderMcpServer.Type;

export const ProviderMcpListInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderMcpListInput = typeof ProviderMcpListInput.Type;

export const ProviderMcpListResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** False when the provider cannot report its MCP servers to Cinderdeck. */
  supported: Schema.Boolean,
  servers: Schema.Array(ProviderMcpServer),
  checkedAt: IsoDateTime,
});
export type ProviderMcpListResult = typeof ProviderMcpListResult.Type;

/**
 * MCP servers and tools a user turned off for one provider instance.
 * Applied when a session starts or resumes; the provider's own configuration
 * is never modified.
 */
export const ProviderMcpPreferences = Schema.Struct({
  disabledServers: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  disabledTools: Schema.Record(TrimmedNonEmptyString, Schema.Array(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type ProviderMcpPreferences = typeof ProviderMcpPreferences.Type;

export const EMPTY_PROVIDER_MCP_PREFERENCES: ProviderMcpPreferences = {
  disabledServers: [],
  disabledTools: {},
};

export function isProviderMcpPreferencesEmpty(preferences: ProviderMcpPreferences): boolean {
  return (
    preferences.disabledServers.length === 0 &&
    Object.values(preferences.disabledTools).every((tools) => tools.length === 0)
  );
}
