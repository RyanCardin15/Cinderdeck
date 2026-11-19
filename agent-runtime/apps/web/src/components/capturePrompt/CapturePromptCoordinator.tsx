import { useEffect, useRef, useState } from "react";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { toastManager } from "../ui/toast";
import {
  CapturePromptDialog,
  preparePromptCapture,
  type OpenCapturePrompt,
} from "./CapturePromptDialog";

export function CapturePromptCoordinator() {
  const environment = usePrimaryEnvironmentId();
  const [capture, setCapture] = useState<OpenCapturePrompt | null>(null);
  const requestPending = useRef(false);
  // oxlint-disable-next-line cinderdeck/no-unreasoned-state-sync -- Subscribe to native capture notifications while the desktop composer is available.
  useEffect(() => {
    const bridge = window.desktopBridge;
    const prompt = bridge?.capturePrompt;
    if (!environment || !prompt || capture) return;
    // Pull from the desktop's single pending slot so a capture survives the
    // renderer mounting after the notification. Serialize competing pulls.
    let active = true;
    const take = async () => {
      if (!active || requestPending.current) return;
      requestPending.current = true;
      try {
        const result = await prompt.take();
        if (result) setCapture({ capture: result.source, load: preparePromptCapture(result) });
      } catch {
        toastManager.add({ type: "error", title: "Could not open capture prompt" });
      } finally {
        requestPending.current = false;
      }
    };
    const unsubscribe = bridge.onMenuAction((action) => {
      if (action === "cinderdeck-capture-prompt") void take();
    });
    queueMicrotask(() => void take());
    return () => {
      active = false;
      unsubscribe();
    };
  }, [capture, environment]);
  return capture && environment ? (
    <CapturePromptDialog
      key={capture.capture.id}
      request={capture}
      environmentId={environment}
      onClose={() => setCapture(null)}
    />
  ) : null;
}
