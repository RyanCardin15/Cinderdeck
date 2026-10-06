import { randomUUID } from "../../lib/utils";
import { useEffect, useRef, useState } from "react";
import { MicIcon, SquareIcon, XIcon, SettingsIcon } from "lucide-react";
import type { DictationEvent } from "@cinderdeck/contracts";
import { Button } from "../ui/button";

/** A session belongs to this mounted draft. Navigation cancels it; edits keep the result for manual copying. */
export function DictationButton({
  draft,
  insert,
}: {
  draft: string;
  insert: (text: string, expected: string) => boolean;
}) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const available = bridge?.isNativeHost?.() === true && !!bridge.dictation && !!bridge.onDictation;
  const [state, setState] = useState<DictationEvent["state"]>("idle");
  const [error, setError] = useState("");
  const [recovered, setRecovered] = useState("");
  const active = useRef<{ id: string; draft: string; edited: boolean } | null>(null);
  const insertRef = useRef(insert);
  insertRef.current = insert;
  if (active.current && active.current.draft !== draft) active.current.edited = true;
  const busy = ["preparing", "recording", "transcribing"].includes(state);

  useEffect(() => {
    if (!available) return;
    const unsubscribe = bridge!.onDictation!((event) => {
      const session = active.current;
      if (!session || event.requestID !== session.id) return;
      setState(event.state);
      if (event.error) setError(event.error);
      if (event.state === "completed" && event.text) {
        if (session.edited || !insertRef.current(event.text, session.draft)) {
          setRecovered(event.text);
          setError(
            "Your draft changed during dictation. Copy the transcript below to keep your edits.",
          );
        }
      }
      if (["idle", "completed", "error"].includes(event.state)) active.current = null;
    });
    return () => {
      unsubscribe();
      if (active.current)
        void bridge!.dictation!({ action: "cancel", requestID: active.current.id }).catch(
          () => undefined,
        );
      active.current = null;
    };
  }, [available, bridge]);

  async function command(action: "start" | "stop" | "cancel") {
    if (!available) return;
    if (action === "start") {
      if (active.current) return;
      active.current = { id: randomUUID(), draft, edited: false };
      setError("");
      setRecovered("");
      setState("preparing");
    }
    const session = active.current;
    if (!session) return;
    if (action === "stop") setState("transcribing");
    try {
      if (!(await bridge!.dictation!({ action, requestID: session.id }))) throw new Error();
    } catch {
      setState("error");
      setError("The native dictation connection is unavailable. Reopen Cinderdeck and try again.");
      active.current = null;
    }
  }
  if (!available) return null;
  return (
    <div className="relative flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={state === "recording" ? "Stop dictation" : "Start dictation"}
        title={state === "recording" ? "Stop dictation" : "Dictate into this draft"}
        disabled={state === "preparing" || state === "transcribing"}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => void command(state === "recording" ? "stop" : "start")}
      >
        {state === "recording" ? <SquareIcon className="text-red-500" /> : <MicIcon />}
      </Button>
      {busy && (
        <>
          <span className="sr-only" role="status">
            {state === "recording"
              ? "Listening…"
              : state === "preparing"
                ? "Starting…"
                : "Transcribing…"}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Cancel dictation"
            onClick={() => void command("cancel")}
          >
            <XIcon />
          </Button>
        </>
      )}
      {!busy && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Dictation settings"
          title="Dictation settings"
          onClick={() =>
            void bridge!
              .openNativeTool?.({ surface: "preferences", mode: "dictation" })
              .catch(() => setError("Could not open dictation settings."))
          }
        >
          <SettingsIcon className="size-3" />
        </Button>
      )}
      {(error || recovered) && (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-80 rounded-lg border bg-popover p-3 text-sm shadow-lg">
          <p role="alert">{error}</p>
          {recovered && (
            <textarea
              aria-label="Recovered dictation transcript"
              readOnly
              value={recovered}
              className="mt-2 max-h-40 w-full select-text rounded border p-2"
            />
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setError("");
              setRecovered("");
            }}
          >
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}
