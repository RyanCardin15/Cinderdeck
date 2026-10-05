import { useEffect, useRef, useState } from "react";
import { FilmIcon } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RecordingContext } from "@t3tools/contracts/deckhand/recordingsRpc";
import { useEnvironmentHttpBaseUrl } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { recordingThumbnail } from "./recordingState";
import styles from "./recordingThumbnail.module.css";

// Visible rows share two extraction slots. Scrolling through a library never
// launches one decoder per recording, and offscreen rows request no image.
let active = 0;
const waiting: Array<() => void> = [];
async function boundedThumbnail<A>(request: () => Promise<A>): Promise<A> {
  await new Promise<void>((resolve) => {
    const enter = () => {
      active++;
      resolve();
    };
    if (active < 2) enter();
    else waiting.push(enter);
  });
  try {
    return await request();
  } finally {
    active--;
    waiting.shift()?.();
  }
}
export function RecordingThumbnail({
  environmentId,
  context,
  recordingID,
  playable,
  title,
  duration,
  className,
}: {
  environmentId: EnvironmentId;
  context: RecordingContext;
  recordingID: string;
  playable: boolean;
  title: string;
  duration?: number | undefined;
  className?: string | undefined;
}) {
  const request = useAtomCommand(recordingThumbnail, { reportFailure: false });
  const baseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const node = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const element = node.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setUrl(null);
    setUnavailable(false);
    if (!visible || !playable || !baseUrl) return;
    let cancelled = false;
    void boundedThumbnail(async () => {
      if (cancelled) return;
      const result = await request({
        environmentId,
        input: {
          installationID: context.installationID,
          workspaceID: context.workspaceID,
          generation: context.generation,
          recordingID,
        },
      });
      if (cancelled) return;
      if (result._tag === "Success") setUrl(new URL(result.value.path, baseUrl).toString());
      else setUnavailable(true);
    }).catch(() => {
      if (!cancelled) setUnavailable(true);
    });
    return () => {
      cancelled = true;
    };
  }, [
    visible,
    playable,
    baseUrl,
    environmentId,
    context.installationID,
    context.workspaceID,
    context.generation,
    recordingID,
    request,
  ]);
  const stamp =
    duration === undefined
      ? null
      : `${Math.floor(duration / 60)
          .toString()
          .padStart(2, "0")}:${Math.floor(duration % 60)
          .toString()
          .padStart(2, "0")}`;
  return (
    <span
      ref={node}
      className={`${styles.frame} ${className ?? ""}`}
      style={{ padding: 0, height: duration === undefined ? "100%" : 58 }}
      title={unavailable ? "Thumbnail unavailable" : undefined}
    >
      {url ? (
        <img
          src={url}
          alt={`Recorded frame from ${title}`}
          loading="lazy"
          decoding="async"
          onError={() => {
            setUrl(null);
            setUnavailable(true);
          }}
        />
      ) : (
        <FilmIcon size={22} aria-hidden="true" />
      )}
      {stamp ? <code className={styles.duration}>{stamp}</code> : null}
    </span>
  );
}
