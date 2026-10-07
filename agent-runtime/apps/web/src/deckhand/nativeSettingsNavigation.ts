import type { NativeSettingsCategory } from "@cinderdeck/contracts";

export const NATIVE_SETTINGS_PAGES = {
  "/settings/capture": {
    category: "capture",
    title: "Capture",
    description: "Screenshots, text recognition and what happens after a capture.",
  },
  "/settings/recording": {
    category: "recording",
    title: "Recording",
    description: "Video, audio and overlays for screen recordings.",
  },
  "/settings/annotations": {
    category: "annotate",
    title: "Annotations",
    description: "Your image editor, tools and editing defaults.",
  },
  "/settings/dictation": {
    category: "dictation",
    title: "Dictation",
    description: "Speech recognition and hold-to-talk on this Mac.",
  },
  "/settings/quick-access": {
    category: "quickAccess",
    title: "Quick access",
    description: "The floating capture card, its actions and gestures.",
  },
  "/settings/menu-bar": {
    category: "menuBar",
    title: "Menu bar",
    description: "Customize the menu and icon on this Mac.",
  },
  "/settings/capture-history": {
    category: "history",
    title: "History & clipboard",
    description: "Saved captures, clipboard history and retention.",
  },
  "/settings/cloud-uploads": {
    category: "cloud",
    title: "Cloud uploads",
    description: "Connect your own storage for capture uploads.",
  },
  "/settings/permissions": {
    category: "permissions",
    title: "Permissions",
    description: "System access used by Cinderdeck on this Mac.",
  },
  "/settings/updates": {
    category: "updates",
    title: "Updates",
    description: "Updates for the complete Cinderdeck application.",
  },
  "/settings/advanced": {
    category: "advanced",
    title: "Advanced",
    description: "Native diagnostics and configuration.",
  },
  "/settings/about": {
    category: "about",
    title: "About Cinderdeck",
    description: "Version, support and open source acknowledgments.",
  },
} as const satisfies Record<
  string,
  { category: NativeSettingsCategory; title: string; description: string }
>;
export type NativeSettingsPath = keyof typeof NATIVE_SETTINGS_PAGES;
export const NATIVE_SETTINGS_TARGETS = {
  general: { to: "/settings/general", hash: "native-general" },
  appearance: { to: "/settings/appearance", hash: "native-appearance" },
  shortcuts: { to: "/settings/keybindings", hash: "native-shortcuts" },
  workspaces: { to: "/settings/workspaces", hash: "native-workspaces" },
  github: { to: "/settings/source-control", hash: "native-github" },
  ...Object.fromEntries(
    Object.entries(NATIVE_SETTINGS_PAGES).map(([to, page]) => [
      page.category,
      { to, hash: `native-${page.category}` },
    ]),
  ),
} as Record<
  NativeSettingsCategory,
  {
    to:
      | "/settings/general"
      | "/settings/appearance"
      | "/settings/keybindings"
      | "/settings/workspaces"
      | "/settings/source-control"
      | NativeSettingsPath;
    hash: string;
  }
>;

export function nativeSettingsTarget(section: string) {
  if (!section.startsWith("settings:")) return null;
  const category = section.slice("settings:".length);
  return Object.hasOwn(NATIVE_SETTINGS_TARGETS, category)
    ? NATIVE_SETTINGS_TARGETS[category as NativeSettingsCategory]
    : null;
}
