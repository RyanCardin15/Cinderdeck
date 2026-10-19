import * as Schema from "effect/Schema";
import { fromYaml } from "@cinderdeck/shared/schemaYaml";

const metadata = fromYaml(Schema.Struct({ name: Schema.String, description: Schema.String }));

/** Parse actual YAML, including quoted and folded descriptions; reject malformed provider metadata. */
export function skillMetadata(content: string): { name: string; description: string } {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter)
    throw new Error(
      "Choose a skill folder containing SKILL.md with name and description frontmatter.",
    );
  let value;
  try {
    value = Schema.decodeSync(metadata)(frontmatter);
  } catch {
    throw new Error("SKILL.md must have valid YAML with a text name and description.");
  }
  if (
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.name) ||
    !value.description.trim() ||
    value.description.length > 5000
  )
    throw new Error(
      "SKILL.md needs a lowercase hyphenated name and a description of at most 5000 characters.",
    );
  return { name: value.name, description: value.description.trim() };
}
