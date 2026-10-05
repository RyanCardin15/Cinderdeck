// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as Schema from "effect/Schema";
import * as C from "@t3tools/contracts/deckhand/externalDebugRpc";
import { McpSchema } from "effect/unstable/ai";
import { record } from "./ExternalDebugCDP.ts";

const isSnapshot = Schema.is(C.DebugSnapshot);
export function externalDebugMcpResult(value: unknown): McpSchema.CallToolResult {
  if (!isSnapshot(value)) {
    const failure = record(value);
    return new McpSchema.CallToolResult({
      isError: true,
      structuredContent: failure,
      content: [{ type: "text", text: JSON.stringify(failure) }],
    });
  }
  const metadata = { ...value, image: null, imageIncluded: value.image !== null };
  return new McpSchema.CallToolResult({
    isError: false,
    structuredContent: metadata,
    content: [
      { type: "text", text: JSON.stringify(metadata) },
      ...(value.image
        ? [
            {
              type: "image" as const,
              mimeType: "image/jpeg",
              data: new Uint8Array(Buffer.from(value.image, "base64")),
            },
          ]
        : []),
    ],
  });
}
