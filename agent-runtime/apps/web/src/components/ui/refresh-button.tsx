import { useRef, useState } from "react";
import { CheckIcon } from "lucide-react";
import { Button } from "./button";
import { RefreshIcon } from "./refresh-icon";

/** Feedback follows the request, including fast responses and failures. */
export function RefreshButton({
  onRefresh,
  label,
  successMessage = "Refreshed",
  disabled = false,
}: {
  onRefresh: () => Promise<void>;
  label: string;
  successMessage?: string;
  disabled?: boolean;
}) {
  const inFlight = useRef(false);
  const [status, setStatus] = useState<"idle" | "refreshing" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    if (disabled || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setStatus("refreshing");
    // Keep feedback perceptible even when the local host answers immediately.
    const minimumFeedback = new Promise<void>((resolve) => window.setTimeout(resolve, 450));
    try {
      await onRefresh();
      await minimumFeedback;
      setStatus("success");
    } catch (cause) {
      await minimumFeedback;
      setError(cause instanceof Error ? cause.message : "Refresh failed. Try again.");
      setStatus("error");
    } finally {
      inFlight.current = false;
    }
  };
  const refreshing = status === "refreshing";
  return (
    <div className="inline-flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={label}
        aria-busy={refreshing}
        disabled={disabled || refreshing}
        title={label}
        onClick={() => void refresh()}
      >
        {status === "success" ? <CheckIcon aria-hidden /> : <RefreshIcon refreshing={refreshing} />}
        {refreshing ? "Refreshing…" : "Refresh"}
      </Button>
      <span
        role="status"
        className={`text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}
      >
        {refreshing ? "" : (error ?? (status === "success" ? successMessage : ""))}
      </span>
    </div>
  );
}
