/** Developer command for this private runtime; Cinderdeck ships no npm CLI product. */
export function formatCliCommand(input: {
  readonly subcommand: string;
  readonly entryPath: string;
  readonly version: string;
}): string {
  const entry = input.entryPath.trim() || "apps/server/src/bin.ts";
  const quoted = "'" + entry.replaceAll("'", "'\\''") + "'";
  return `node ${quoted} ${input.subcommand}`;
}
