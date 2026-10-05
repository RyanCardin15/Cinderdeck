import { useEffect, useRef, useState } from "react";
import { AuthAccessReadScope, AuthAccessWriteScope, type EnvironmentId } from "@cinderdeck/contracts";
import type * as C from "@cinderdeck/contracts/deckhand/historyImportRpc";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { usePrimarySessionState } from "../environments/primary";
import { useEnvironmentSessionState } from "../state/session";
import { isElectron } from "../env";
import { randomUUID } from "../lib/utils";
import {
  importHistory,
  historyImportGet,
  historyImportsList,
  historyThreads,
  historyMessages,
  historyMessageText,
  historyImportRemove,
} from "./historyImportState";
import styles from "./historyImport.module.css";
export function HistoryImportPanel() {
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const [environmentID, setEnvironmentID] = useState<EnvironmentId | null>(primary);
  const selected = environments.find((environment) => environment.environmentId === environmentID);
  return (
    <section id="storage-history-import" className={styles.panel} aria-label="Import Cinderdeck history">
      <h2>Bring your Cinderdeck history</h2>
      <p>
        Copy previous conversations into a separate Cinderdeck history archive. Your Cinderdeck database
        stays unchanged. Credentials, pending work and provider sessions are not imported.
      </p>
      <label className={styles.field}>
        Execution computer
        <select
          value={environmentID ?? ""}
          onChange={(event) =>
            setEnvironmentID(
              environments.find((environment) => environment.environmentId === event.target.value)
                ?.environmentId ?? null,
            )
          }
        >
          <option value="">Choose a computer</option>
          {environmentID && !selected ? (
            <option value={environmentID}>Unavailable computer</option>
          ) : null}
          {environments.map((environment) => (
            <option key={environment.environmentId} value={environment.environmentId}>
              {environment.label}
            </option>
          ))}
        </select>
      </label>
      {selected?.connection.phase === "connected" ? (
        <HistoryImportAccess key={selected.environmentId} environmentID={selected.environmentId} />
      ) : (
        <p role="status">Reconnect the selected computer to view or copy its history.</p>
      )}
    </section>
  );
}
function HistoryImportAccess({ environmentID }: { environmentID: EnvironmentId }) {
  const primary = usePrimaryEnvironmentId();
  const primarySession = usePrimarySessionState();
  const remote = useEnvironmentSessionState(environmentID);
  const session = primary === environmentID ? primarySession.data : remote.data;
  const desktopOwner = isElectron && primary === environmentID;
  const canRead =
    desktopOwner ||
    Boolean(session?.authenticated && session.scopes?.includes(AuthAccessReadScope));
  const canWrite =
    desktopOwner ||
    Boolean(session?.authenticated && session.scopes?.includes(AuthAccessWriteScope));
  return canRead ? (
    <HistoryArchiveBrowser environmentID={environmentID} canWrite={canWrite} />
  ) : (
    <p role="status">Administrator access is required to read imported history on this computer.</p>
  );
}
export function HistoryArchiveBrowser({
  environmentID,
  canWrite = true,
}: {
  environmentID: EnvironmentId;
  canWrite?: boolean;
}) {
  const copy = useAtomCommand(importHistory, { reportFailure: false });
  const get = useAtomCommand(historyImportGet, { reportFailure: false });
  const list = useAtomCommand(historyImportsList, { reportFailure: false });
  const threads = useAtomCommand(historyThreads, { reportFailure: false });
  const messages = useAtomCommand(historyMessages, { reportFailure: false });
  const remove = useAtomCommand(historyImportRemove, { reportFailure: false });
  const [path, setPath] = useState("");
  const copyIntent = useRef<{ sourceDatabasePath: string; operationKey: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reports, setReports] = useState<C.HistoryImportReport[]>([]);
  const [offset, setOffset] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const [report, setReport] = useState<C.HistoryImportReport | null>(null);
  const [threadPage, setThreadPage] = useState<C.HistoryThreadPage | null>(null);
  const [threadOffset, setThreadOffset] = useState(0);
  const [thread, setThread] = useState<C.HistoryThread | null>(null);
  const [messagePage, setMessagePage] = useState<C.HistoryMessagePage | null>(null);
  const [messageOffset, setMessageOffset] = useState(0);
  useEffect(() => {
    if (report?.state === "preparing") return;
    let current = true;
    void list({ environmentId: environmentID, input: { offset, limit: 20 } }).then((result) => {
      if (!current) return;
      if (result._tag === "Success") {
        setReports([...result.value.items]);
        setNext(result.value.nextOffset);
      } else setError("Imported history is unavailable on this computer.");
    });
    return () => {
      current = false;
    };
  }, [environmentID, list, offset, report?.state]);
  useEffect(() => {
    if (report?.state !== "preparing") return;
    let current = true;
    const refresh = () => {
      void get({ environmentId: environmentID, input: { importID: report.importID } }).then(
        (result) => {
          if (!current) return;
          if (result._tag === "Success") setReport(result.value);
          else
            setError(
              "Copy status is unavailable. Keep this import ID and reconnect to recover its report.",
            );
        },
      );
    };
    const timer = window.setInterval(refresh, 1500);
    refresh();
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [environmentID, get, report?.importID, report?.state]);
  useEffect(() => {
    if (report?.state !== "ready") return;
    let current = true;
    void threads({
      environmentId: environmentID,
      input: { importID: report.importID, offset: threadOffset, limit: 50 },
    }).then((result) => {
      if (current) {
        if (result._tag === "Success") setThreadPage(result.value);
        else setError("This historical thread page is unavailable.");
      }
    });
    return () => {
      current = false;
    };
  }, [environmentID, report?.importID, report?.state, threads, threadOffset]);
  const importID = report?.importID;
  const threadID = thread?.threadID;
  useEffect(() => {
    if (!importID || !threadID) return;
    let current = true;
    void messages({
      environmentId: environmentID,
      input: {
        importID,
        threadID,
        offset: messageOffset,
        limit: 20,
      },
    }).then((result) => {
      if (current) {
        if (result._tag === "Success") setMessagePage(result.value);
        else setError("This historical message page is unavailable.");
      }
    });
    return () => {
      current = false;
    };
  }, [environmentID, messages, importID, threadID, messageOffset]);
  const choose = (value: C.HistoryImportReport) => {
    setError(null);
    setThreadOffset(0);
    setMessageOffset(0);
    setThread(null);
    setThreadPage(null);
    setMessagePage(null);
    setReport(value);
  };
  const begin = async () => {
    setBusy(true);
    setError(null);
    const sourceDatabasePath = path.trim();
    if (copyIntent.current?.sourceDatabasePath !== sourceDatabasePath)
      copyIntent.current = { sourceDatabasePath, operationKey: randomUUID() };
    const result = await copy({ environmentId: environmentID, input: copyIntent.current });
    if (result._tag === "Success") choose(result.value);
    else
      setError(
        "History copy was refused. Use the real absolute path to a supported Cinderdeck V2 database and an account with administrator access.",
      );
    setBusy(false);
  };
  return (
    <>
      {canWrite ? (
        <div className={styles.copy}>
          <label className={styles.field}>
            Cinderdeck database path on this computer
            <input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder="/absolute/path/to/userdata/statev2.sqlite"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button type="button" disabled={busy || !path.trim()} onClick={() => void begin()}>
            {busy ? "Starting copy…" : "Copy Cinderdeck history"}
          </button>
          <small>
            Requires administrator access. Schema versions 55 and 56 are supported. Import is
            history only; starting a new agent remains a separate action.
          </small>
        </div>
      ) : null}
      {!canWrite ? (
        <p>Administrator write access is required to copy or remove an archive.</p>
      ) : null}
      {error ? (
        <p role="alert" className={styles.notice}>
          {error}
        </p>
      ) : null}
      <div className={styles.archiveList} aria-label="Imported archives">
        {reports.map((item) => (
          <button
            type="button"
            key={item.importID}
            aria-pressed={report?.importID === item.importID}
            onClick={() => choose(item)}
          >
            <strong>{item.sourceLabel}</strong>
            <span>
              {item.state} · {item.threads} threads · {item.messages} messages
            </span>
          </button>
        ))}
        {reports.length === 0 ? <p>No imported history yet.</p> : null}
      </div>
      <div className={styles.pager}>
        <button
          type="button"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          Previous archives
        </button>
        <button
          type="button"
          disabled={next === null}
          onClick={() => next !== null && setOffset(next)}
        >
          Next archives
        </button>
      </div>
      {report ? (
        <div className={styles.report} aria-label="History import report">
          <h3>{report.state === "preparing" ? "Copying history…" : "Import report"}</h3>
          <p>{report.detail}</p>
          <dl>
            <div>
              <dt>Schema</dt>
              <dd>
                {report.sourceSchemaVersion ?? "Checking"} → history archive{" "}
                {report.archiveSchemaVersion}
              </dd>
            </div>
            <div>
              <dt>History</dt>
              <dd>
                {report.threads} threads · {report.messages} messages
              </dd>
            </div>
            <div>
              <dt>Original IDs</dt>
              <dd>
                {report.state === "ready"
                  ? "Preserved in this separate archive"
                  : report.state === "removed"
                    ? "Imported archive removed"
                    : "History not published yet"}
              </dd>
            </div>
            <div>
              <dt>Provider continuation</dt>
              <dd>Unavailable</dd>
            </div>
            {report.attachmentsNotCopied > 0 ? (
              <div>
                <dt>Attachment files</dt>
                <dd>{report.attachmentsNotCopied} references retained; files were not copied</dd>
              </div>
            ) : null}
          </dl>
          <details>
            <summary>Import ID and snapshot fingerprint</summary>
            <code>{report.importID}</code>
            <code>{report.sourceSha256 ?? "Snapshot not completed"}</code>
            <p>Excluded: {report.exclusions.join("; ")}.</p>
          </details>
          {canWrite && report.state !== "preparing" && report.state !== "removed" ? (
            <button
              type="button"
              onClick={() =>
                void remove({
                  environmentId: environmentID,
                  input: { importID: report.importID },
                }).then((result) => {
                  if (result._tag === "Success") choose(result.value);
                  else
                    setError(
                      "This archive could not be removed. Reconnect with administrator access and try again.",
                    );
                })
              }
            >
              Remove imported archive
            </button>
          ) : null}
        </div>
      ) : null}
      {report?.state === "ready" ? (
        <div className={styles.history}>
          <div className={styles.threadList} aria-label="Historical threads">
            {threadPage?.items.map((item) => (
              <button
                type="button"
                key={item.threadID}
                aria-pressed={thread?.threadID === item.threadID}
                onClick={() => {
                  setMessagePage(null);
                  setThread(item);
                  setMessageOffset(0);
                }}
              >
                <strong>{item.title}</strong>
                <span>
                  {item.provider} · {item.messageCount} messages{item.archived ? " · Archived" : ""}
                  {item.deleted ? " · Deleted in Cinderdeck" : ""}
                </span>
              </button>
            ))}
            <div className={styles.pager}>
              <button
                disabled={threadOffset === 0}
                onClick={() => {
                  setThreadPage(null);
                  setThread(null);
                  setMessagePage(null);
                  setThreadOffset(Math.max(0, threadOffset - 50));
                }}
              >
                Previous threads
              </button>
              <button
                disabled={threadPage?.nextOffset == null}
                onClick={() =>
                  threadPage?.nextOffset != null &&
                  (() => {
                    setThreadPage(null);
                    setThread(null);
                    setMessagePage(null);
                    setThreadOffset(threadPage.nextOffset);
                  })()
                }
              >
                Next threads
              </button>
            </div>
          </div>
          <div className={styles.messages} aria-label="Historical conversation">
            {thread ? (
              <>
                <h3>{thread.title}</h3>
                <p className={styles.hint}>Saved history · {thread.threadID}</p>
                {messagePage?.items.map((message) => (
                  <HistoryMessage
                    key={message.messageID}
                    environmentID={environmentID}
                    importID={report.importID}
                    message={message}
                  />
                ))}
                {messagePage?.total === 0 ? <p>This thread has no saved messages.</p> : null}
                <div className={styles.pager}>
                  <button
                    disabled={messageOffset === 0}
                    onClick={() => {
                      setMessagePage(null);
                      setMessageOffset(Math.max(0, messageOffset - 20));
                    }}
                  >
                    Previous messages
                  </button>
                  <button
                    disabled={messagePage?.nextOffset == null}
                    onClick={() =>
                      messagePage?.nextOffset != null &&
                      (() => {
                        setMessagePage(null);
                        setMessageOffset(messagePage.nextOffset);
                      })()
                    }
                  >
                    Next messages
                  </button>
                </div>
              </>
            ) : (
              <p>Choose a historical conversation to read its messages.</p>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
function HistoryMessage({
  environmentID,
  importID,
  message,
}: {
  environmentID: EnvironmentId;
  importID: string;
  message: C.HistoryMessage;
}) {
  const read = useAtomCommand(historyMessageText, { reportFailure: false });
  const [text, setText] = useState(message.text);
  const [next, setNext] = useState(message.nextTextOffset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <article className={styles.message}>
      <header>
        <strong>{message.role}</strong>
        <time>{message.createdAt}</time>
      </header>
      <pre>{text}</pre>
      {message.attachmentsNotCopied > 0 ? (
        <p>Attachment metadata is preserved; original files are unavailable in this archive.</p>
      ) : null}
      {next !== null ? (
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void read({
              environmentId: environmentID,
              input: { importID, messageID: message.messageID, offset: next, limit: 32768 },
            }).then((result) => {
              if (result._tag === "Success") {
                setText((value) => value + result.value.text);
                setNext(result.value.nextOffset);
                setError(false);
              } else setError(true);
              setBusy(false);
            });
          }}
        >
          {busy ? "Loading…" : "Read more of this message"}
        </button>
      ) : null}
      {error ? (
        <p role="alert">More message text is unavailable. Reconnect and try again.</p>
      ) : null}
    </article>
  );
}
