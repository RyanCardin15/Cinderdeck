import { DEFAULT_SIDEBAR_HIGHLIGHT_COLORS } from "@cinderdeck/contracts/settings";
import { isSidebarColor } from "../../deckhand/workspaceSidebarPreferences";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function HighlightPaletteSettings({
  colors,
  onChange,
}: {
  colors: readonly string[];
  onChange: (colors: readonly string[]) => void;
}) {
  const changed = colors.some(
    (color, index) => color.toLowerCase() !== DEFAULT_SIDEBAR_HIGHLIGHT_COLORS[index],
  );
  return (
    <SettingsRow
      {...searchableSetting("sidebar-highlight-colors")}
      description="Choose the ten presets shown when highlighting workspaces, sessions, and sub-agents."
      resetAction={
        changed ? (
          <SettingResetButton
            label="highlight colors"
            onClick={() => onChange([...DEFAULT_SIDEBAR_HIGHLIGHT_COLORS])}
          />
        ) : null
      }
    >
      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-5"
        role="group"
        aria-label="Highlight presets"
      >
        {colors.map((color, index) => (
          <label
            key={DEFAULT_SIDEBAR_HIGHLIGHT_COLORS[index]}
            className="flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2"
          >
            <input
              type="color"
              aria-label={`Highlight color ${index + 1}`}
              value={color}
              className="size-8 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (isSidebarColor(value)) {
                  onChange(colors.map((current, slot) => (slot === index ? value : current)));
                }
              }}
            />
            <span className="min-w-0 text-xs">
              <span className="block">Highlight {index + 1}</span>
              <span className="block font-mono text-3xs text-muted-foreground">{color}</span>
            </span>
          </label>
        ))}
      </div>
    </SettingsRow>
  );
}
