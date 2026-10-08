import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { CinderdeckProjectFile, CINDERDECK_PROJECT_FILE_SCHEMA_URL } from "@cinderdeck/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `t3.json` file contents (lenient JSONC string) and the
 * decoded {@link CinderdeckProjectFile}.
 */
export const CinderdeckProjectFileFromJson = fromLenientJson(CinderdeckProjectFile);

const decodeCinderdeckProjectFile = Schema.decodeExit(CinderdeckProjectFileFromJson);

/**
 * Decode raw `t3.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parseCinderdeckProjectFile(contents: string): CinderdeckProjectFile | null {
  const decoded = decodeCinderdeckProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/**
 * Build the publishable JSON Schema document for `t3.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link CINDERDECK_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildCinderdeckProjectFileJsonSchema(): Record<string, unknown> {
  // Closed objects, as before effect rc.113 changed the generator default;
  // editors then flag unknown keys in t3.json.
  const document = Schema.toJsonSchemaDocument(CinderdeckProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: CINDERDECK_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
