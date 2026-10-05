import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { McpSchema, Tool } from "effect/unstable/ai";
import { ExternalDebugToolkit } from "./externalDebug.ts";

const isMcpSchema = Schema.is(McpSchema.ToolJsonSchema);
it("registers every external debugging tool with an MCP object input schema", () => {
  // An empty Effect Struct exports {not:{type:null}}, which the MCP registration
  // layer rejects at startup. Catalog/presentation checks cannot catch this.
  for (const tool of Object.values(ExternalDebugToolkit.tools)) {
    expect(isMcpSchema(Tool.getJsonSchema(tool)), tool.name).toBe(true);
    const output = Tool.getJsonSchemaFromSchema(tool.successSchema);
    if (output.type === "object") expect(isMcpSchema(output), tool.name).toBe(true);
  }
});
