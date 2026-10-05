import type { WorkspaceSearch } from "./workspaceNavigation";
import { Link } from "@tanstack/react-router";
import { FilmIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { EnvironmentId } from "@cinderdeck/contracts";
import type {
  RecordingContext,
  RecordingContextOverview,
} from "@cinderdeck/contracts/deckhand/recordingsRpc";
import { useAtomCommand } from "../state/use-atom-command";
import { recordingOverview } from "./recordingState";
import styles from "./recordingSummary.module.css";
export function RecordingContextSummary({
  environmentId,
  context,
  enabled = true,
  workspaceSearch,
}: {
  environmentId: EnvironmentId;
  context: RecordingContext;
  enabled?: boolean;
  workspaceSearch?: WorkspaceSearch;
}) {
  const overview = useAtomCommand(recordingOverview, { reportFailure: false });
  const [value, setValue] = useState<RecordingContextOverview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    setValue(null);
    setFailed(false);
    let cancelled = false;
    void overview({
      environmentId,
      input: {
        installationID: context.installationID,
        contexts: [{ workspaceID: context.workspaceID, generation: context.generation }],
      },
    }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") {
        setValue(result.value[0] ?? null);
        setFailed(false);
      } else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [
    overview,
    environmentId,
    enabled,
    context.installationID,
    context.workspaceID,
    context.generation,
  ]);
  return (
    <details className={styles.summary}>
      <summary>
        <FilmIcon size={15} aria-hidden />
        Recordings<span>{enabled && !failed && value ? value.count : "—"}</span>
      </summary>
      <div className={styles.popover}>
        <h2>Recorded evidence</h2>
        {!enabled || failed ? (
          <p>
            Recording state is unavailable. Reconnect this execution computer to inspect its
            library.
          </p>
        ) : !value ? (
          <p>Loading this lane’s recordings…</p>
        ) : (
          <>
            <p>
              {value.count} recording{value.count === 1 ? "" : "s"} · {value.playableCount} with
              video
            </p>
            {value.active ? (
              <p className={styles.active}>
                {value.active.state === "recording" ? "Recording" : "Saving"}: {value.active.title}
              </p>
            ) : null}
            {value.latest ? (
              <Link
                className={styles.latest}
                to={workspaceSearch ? "/workspaces" : "/recordings"}
                search={
                  workspaceSearch
                    ? { ...workspaceSearch, tab: "recordings", recording: value.latest.id }
                    : {
                        environment: environmentId,
                        workspace: context.workspaceID,
                        recording: value.latest.id,
                      }
                }
              >
                <FilmIcon size={23} />
                <span>
                  <strong>{value.latest.title}</strong>
                  <small>
                    {Math.floor(value.latest.duration / 60)}:
                    {Math.floor(value.latest.duration % 60)
                      .toString()
                      .padStart(2, "0")}{" "}
                    · {value.latest.playable ? "Video available" : "Video unavailable"}
                  </small>
                </span>
                <ChevronRightIcon size={14} />
              </Link>
            ) : (
              <p>No recording is attached to this lane yet.</p>
            )}
          </>
        )}
        <Link
          to={workspaceSearch ? "/workspaces" : "/recordings"}
          search={
            workspaceSearch
              ? { ...workspaceSearch, tab: "recordings" }
              : { environment: environmentId, workspace: context.workspaceID }
          }
        >
          Open recording library <ChevronRightIcon size={14} />
        </Link>
      </div>
    </details>
  );
}
