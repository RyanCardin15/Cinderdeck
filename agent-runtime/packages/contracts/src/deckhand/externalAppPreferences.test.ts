import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { ClientSettingsSchema, ClientSettingsPatch } from "../settings.ts";
import { EXCEL_EXTERNAL_APP, resolveExternalAppProfiles } from "./externalAppPreferences.ts";

const decodeSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodePatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const encodeSettings = Schema.encodeSync(ClientSettingsSchema);

it("offers Excel by default and preserves an explicit disabled preference", () => {
  expect(decodeSettings({}).externalAppProfiles).toEqual([EXCEL_EXTERNAL_APP]);
  expect(
    decodeSettings({ externalAppProfiles: [{ ...EXCEL_EXTERNAL_APP, enabled: false }] })
      .externalAppProfiles[0]?.enabled,
  ).toBe(false);
  const patch = {
    externalAppProfiles: [
      { ...EXCEL_EXTERNAL_APP, enabled: true, includeInspector: false, applicationFilter: "Excel" },
    ],
  };
  expect(decodePatch(patch)).toEqual(patch);
  expect(encodeSettings(decodeSettings(patch))).toMatchObject(patch);
});
it("keeps the Excel preset first and unique while bounding restored custom profiles", () => {
  const custom = { ...EXCEL_EXTERNAL_APP, id: "custom", name: "Custom" };
  expect(resolveExternalAppProfiles([custom, custom])).toEqual([EXCEL_EXTERNAL_APP, custom]);
  expect(
    resolveExternalAppProfiles(
      Array.from({ length: 16 }, (_, index) => ({ ...custom, id: `app-${index}` })),
    ),
  ).toHaveLength(16);
});
it("rejects unsafe profile IDs and oversized viewer settings", () => {
  const decode = decodePatch;
  expect(() =>
    decode({ externalAppProfiles: [{ ...EXCEL_EXTERNAL_APP, id: "../app" }] }),
  ).toThrow();
  expect(() =>
    decode({ externalAppProfiles: [{ ...EXCEL_EXTERNAL_APP, name: "x".repeat(121) }] }),
  ).toThrow();
  expect(() => decode({ externalAppProfiles: Array(17).fill(EXCEL_EXTERNAL_APP) })).toThrow();
});
