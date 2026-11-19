import { createFileRoute } from "@tanstack/react-router";
import { CapturePromptSettings } from "../components/capturePrompt/CapturePromptSettings";

export const Route = createFileRoute("/_chat/settings/capture")({
  component: CapturePromptSettings,
});
