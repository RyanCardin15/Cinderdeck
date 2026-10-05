import * as Schema from "effect/Schema";

const name = Schema.String.check(Schema.isMaxLength(120));
export const ExternalAppProfile = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,80}$/)),
  name,
  enabled: Schema.Boolean,
  applicationFilter: name,
  includeInspector: Schema.Boolean,
  inspectorFilter: name,
});
export type ExternalAppProfile = typeof ExternalAppProfile.Type;
export const EXCEL_EXTERNAL_APP: ExternalAppProfile = {
  id: "excel",
  name: "Excel",
  enabled: true,
  applicationFilter: "com.microsoft.Excel",
  includeInspector: true,
  inspectorFilter: "Web Inspector",
};
export const ExternalAppProfiles = Schema.Array(ExternalAppProfile).check(Schema.isMaxLength(16));

export function resolveExternalAppProfiles(profiles: readonly ExternalAppProfile[]) {
  const unique = [...new Map(profiles.map((profile) => [profile.id, profile])).values()];
  return [
    unique.find((profile) => profile.id === "excel") ?? EXCEL_EXTERNAL_APP,
    ...unique.filter((profile) => profile.id !== "excel").slice(0, 15),
  ];
}
