import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { CinderdeckProjectFile, T3_PROJECT_FILE_SCHEMA_URL } from "@cinderdeck/contracts";

import { fromLenientJson } from "./schemaJson.ts";

export const CinderdeckProjectFileFromJson = fromLenientJson(CinderdeckProjectFile);

const decodeT3ProjectFile = Schema.decodeExit(CinderdeckProjectFileFromJson);

export function parseT3ProjectFile(contents: string): CinderdeckProjectFile | null {
  const decoded = decodeT3ProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

export function buildT3ProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(CinderdeckProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: T3_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
