const labels: Record<string, string> = {
  general: "Desktop",
  appearance: "Appearance",
  capture: "Capture",
  recording: "Recording",
  annotate: "Annotations",
  quick_access: "Quick access",
  history: "History",
  menu_bar: "Menu bar",
  shortcuts: "Desktop shortcuts",
  updates: "Updates",
  diagnostics: "Diagnostics",
  stacks: "Workspace defaults",
  ocr: "Text recognition",
  naming: "File names",
  screenshot: "Screenshots",
  scrolling: "Scrolling capture",
  object_cutout: "Object cutout",
  after: "After capture",
  floating: "Floating history",
  global: "Global shortcuts",
  overlay: "Capture overlay",
  slots: "Action slots",
  annotate_tools: "Annotation tools",
  annotate_actions: "Annotation actions",
  card_actions: "Card actions",
  mouse_highlight: "Mouse highlight",
  keystrokes: "Keystroke overlay",
  annotation_shortcuts: "Recording annotation shortcuts",
  include_cinderdeck: "Include Cinderdeck in captures",
  enabled: "Enabled",
  play_sounds: "Play sounds",
  url_scheme_enabled: "Open Cinderdeck links",
  show_menu_bar_icon: "Show menu bar icon",
  start_at_login: "Start at login",
  export_location: "Save folder",
  auto_fetch_minutes: "Fetch interval (minutes)",
  directory: "Workspace definitions folder",
  lanes_directory: "Lane worktrees folder",
  quit_behavior: "When quitting with services running",
  notify_on_crash: "Notify when a service crashes",
  fps: "Frames per second",
  retention_days: "Keep history (days)",
  max_count: "Maximum saved items",
  overlay_scale: "Card scale",
  auto_dismiss_delay: "Auto-dismiss delay (seconds)",
  selected_model: "Recognition model",
  custom_models: "Custom recognition models",
  freeze_area: "Freeze the screen while selecting",
  show_cursor: "Show cursor",
  capture_system_audio: "Record system audio",
  capture_microphone: "Record microphone",
  microphone_device_id: "Microphone",
  model: "Model",
  endpoint: "Service URL",
  format: "Format",
  api_key: "API key",
  hold_delay: "Hold delay (seconds)",
  global_enabled: "Enable hold-to-talk",
  on_device_only: "Require on-device recognition",
  native_language: "macOS language",
  header_name: "Authentication header",
  authentication: "Authentication",
  language: "Language",
  key: "Key",
  shortcut_key: "Hold-to-talk key",
  shortcut_modifiers: "Hold-to-talk modifiers",
  modifiers: "Modifiers",
  system: "Follow system",
  macOS: "macOS speech recognition",
  service: "Transcription service",
  openAI: "OpenAI compatible",
  elevenLabs: "ElevenLabs",
  bearer: "Bearer token",
  header: "Custom header",
  none: "None",
  ask: "Ask",
  stop: "Stop services",
  leave: "Leave services running",
  cloud: "Cloud uploads",
  aws_s3: "Amazon S3",
  cloudflare_r2: "Cloudflare R2",
  google_drive: "Google Drive",
  permanent: "Keep indefinitely",
  command: "⌘ Command",
  control: "⌃ Control",
  option: "⌥ Option",
  shift: "⇧ Shift",
  check_automatically: "Check for updates automatically",
  download_automatically: "Download updates automatically",
  png: "PNG",
  jpeg: "JPEG",
  jpg: "JPEG",
  heic: "HEIC",
  mp4: "MP4",
  mov: "MOV",
  gif: "GIF",
  captureArea: "Area screenshot",
  captureAreaAnnotate: "Capture and annotate",
  captureApplication: "Application screenshot",
  captureFullscreen: "Full-screen screenshot",
  captureActiveWindow: "Active window screenshot",
  scrollingCapture: "Scrolling screenshot",
  captureOCR: "Recognize text",
  captureSmartElement: "Element screenshot",
  captureObjectCutout: "Object cutout",
  recordScreen: "Record screen",
  recordApplication: "Record application",
  openAnnotate: "Annotate an image",
  combineImages: "Combine images",
  editVideo: "Edit a video",
  cloudUploads: "Cloud uploads",
  openHistory: "History & clipboard",
  openWorkspaces: "Workspaces",
  pullRequests: "Pull requests",
  shortcutList: "Shortcut reference",
  checkForUpdates: "Check for updates",
};

export function nativeSettingsGroupLabel(group: string): string {
  if (group === "capture") return "Desktop visibility";
  if (group === "menu_bar") return "Menu icon";
  if (group.startsWith("capture.after."))
    return group.endsWith("recording") ? "After recording" : "After screenshots";
  const parts = group.split(".");
  return (parts.length > 1 ? parts.slice(1) : parts).map(settingLabel).join(" · ");
}

let lastBridge: Window["desktopBridge"];
let lastNativeHost = false;
export function isNativeSettingsHost() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  if (bridge !== lastBridge) {
    lastBridge = bridge;
    lastNativeHost = bridge?.isNativeHost?.() === true;
  }
  return lastNativeHost;
}
export function settingLabel(value: string): string {
  if (!value) return "None";
  if (labels[value]) return labels[value];
  if (/^\d+d$/.test(value)) return `${value.slice(0, -1)} days`;
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[_-]/)
    .map((word, i) => (i ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}
