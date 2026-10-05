import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLinkIcon, XIcon } from "lucide-react";
import type {
  GitHubWorkspaceDetail,
  GitHubWorkspaceFile,
  GitHubWorkspaceInput,
  GitHubWorkspaceRequest,
  GitHubWorkspaceResult,
} from "@t3tools/contracts/deckhand/gitHubWorkspace";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import styles from "./gitHubPullRequests.module.css";

export function requestState(pr: Pick<GitHubWorkspaceRequest, "state" | "isDraft">) {
  return pr.state === "MERGED"
    ? "Merged"
    : pr.state === "CLOSED"
      ? "Closed"
      : pr.isDraft
        ? "Draft"
        : "Open";
}
export function checksLabel(pr: GitHubWorkspaceRequest) {
  const state = pr.commits.nodes.at(-1)?.commit.statusCheckRollup?.state;
  return state === "SUCCESS"
    ? "Passed"
    : state === "FAILURE" || state === "ERROR"
      ? "Failed"
      : state === "PENDING" || state === "EXPECTED"
        ? "Pending"
        : "No checks";
}

export function GitHubPullRequestInspector({
  request,
  identity,
  run,
  onClose,
  onReviewed,
  refreshToken,
}: {
  request: GitHubWorkspaceRequest;
  identity: { account: string; hostname: string };
  run: (input: GitHubWorkspaceInput) => Promise<GitHubWorkspaceResult>;
  onClose: () => void;
  onReviewed: () => void;
  refreshToken: number;
}) {
  const filesEpoch = useRef(0);
  const fileRequestBusy = useRef(false);
  const [detail, setDetail] = useState<GitHubWorkspaceDetail | null>(null);
  const [files, setFiles] = useState<ReadonlyArray<GitHubWorkspaceFile>>([]);
  const [filePage, setFilePage] = useState(1);
  const [hasMoreFiles, setHasMoreFiles] = useState(true);
  const [tab, setTab] = useState("Overview");
  const [error, setError] = useState<string | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [retry, setRetry] = useState(0);
  const [review, setReview] = useState<GitHubWorkspaceDetail | null>(null);
  const [event, setEvent] = useState<"APPROVE" | "REQUEST_CHANGES" | "COMMENT">("COMMENT");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const { account, hostname } = identity;
  useEffect(() => {
    let cancelled = false;
    filesEpoch.current += 1;
    fileRequestBusy.current = false;
    setLoadingFiles(false);
    setDetail(null);
    setError(null);
    setFiles([]);
    setFilePage(1);
    setHasMoreFiles(true);
    setFilesError(null);
    void run({ action: "detail", account, hostname, id: request.id })
      .then((result) => {
        if (!cancelled && result.kind === "detail") setDetail(result.detail);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [account, hostname, request.id, run, refreshToken, retry]);
  useEffect(() => {
    if (tab !== "Files" || !detail || filePage !== 1 || files.length || filesError) return;
    let cancelled = false;
    setLoadingFiles(true);
    void run({
      action: "files",
      account,
      hostname,
      repository: request.repository.nameWithOwner,
      number: request.number,
      page: 1,
    })
      .then((result) => {
        if (!cancelled && result.kind === "files") {
          setLoadingFiles(false);
          setFiles(result.files);
          setHasMoreFiles(result.files.length === 100);
          setFilePage(2);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setLoadingFiles(false);
          setFilesError(errorMessage(cause));
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingFiles(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    tab,
    detail,
    filePage,
    files.length,
    filesError,
    account,
    hostname,
    request.repository.nameWithOwner,
    request.number,
    run,
  ]);
  const loadMore = async () => {
    if (fileRequestBusy.current) return;
    fileRequestBusy.current = true;
    const epoch = filesEpoch.current;
    setLoadingFiles(true);
    setFilesError(null);
    try {
      const result = await run({
        action: "files",
        ...identity,
        repository: request.repository.nameWithOwner,
        number: request.number,
        page: filePage,
      });
      if (epoch === filesEpoch.current && result.kind === "files") {
        setFiles((old) => [
          ...new Map([...old, ...result.files].map((file) => [file.filename, file])).values(),
        ]);
        setHasMoreFiles(result.files.length === 100);
        setFilePage((page) => page + 1);
      }
    } catch (cause) {
      if (epoch === filesEpoch.current) setFilesError(errorMessage(cause));
    } finally {
      if (epoch === filesEpoch.current) {
        fileRequestBusy.current = false;
        setLoadingFiles(false);
      }
    }
  };
  const activity = detail
    ? [...detail.comments.nodes, ...detail.reviews.nodes].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      )
    : [];
  const validation = !review
    ? null
    : review.state !== "OPEN"
      ? "This pull request is no longer open."
      : event !== "COMMENT" && review.author?.login.toLowerCase() === account.toLowerCase()
        ? "You can comment on your own pull request, but cannot approve it or request changes."
        : event !== "COMMENT" && review.isDraft
          ? "This pull request is still a draft."
          : event !== "APPROVE" && !body.trim()
            ? "Write a comment before submitting."
            : null;
  return (
    <aside className={styles.inspector} aria-label="Selected pull request">
      <header>
        <span>
          {request.repository.nameWithOwner} #{request.number}
        </span>
        <a
          href={safeGitHubUrl(request.url, hostname)}
          target="_blank"
          rel="noreferrer"
          aria-label="Open pull request on GitHub"
        >
          <ExternalLinkIcon size={15} />
        </a>
        <button type="button" aria-label="Close pull request details" onClick={onClose}>
          <XIcon size={15} />
        </button>
      </header>
      {error ? (
        <div className={styles.empty} role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry details
          </button>
        </div>
      ) : !detail ? (
        <div className={styles.empty} role="status">
          Loading details…
        </div>
      ) : (
        <>
          <div className={styles.detailTitle}>
            <h2>{request.title}</h2>
            <p>
              <b className={styles[requestState(detail).toLowerCase()]}>{requestState(detail)}</b> ·{" "}
              {request.author?.login ?? "Deleted user"}
            </p>
            <code>
              {detail.headRefName} → {detail.baseRefName}
            </code>
          </div>
          <nav className={styles.detailTabs} aria-label="Pull request details">
            {["Overview", "Files", "Activity"].map((item) => (
              <button
                type="button"
                key={item}
                aria-pressed={tab === item}
                onClick={() => setTab(item)}
              >
                {item}
                {item === "Files" ? ` (${request.changedFiles})` : ""}
              </button>
            ))}
          </nav>
          <div className={styles.detailBody}>
            {tab === "Overview" ? (
              <>
                <dl className={styles.statusCard}>
                  <dt>Checks</dt>
                  <dd>{checksLabel(request)}</dd>
                  <dt>Review</dt>
                  <dd>
                    {detail.reviewDecision?.replaceAll("_", " ").toLowerCase() ??
                      "No review decision"}
                  </dd>
                  <dt>Merge status</dt>
                  <dd>
                    {detail.state !== "OPEN"
                      ? requestState(detail)
                      : detail.mergeable === "CONFLICTING"
                        ? "Has conflicts"
                        : detail.mergeable === "MERGEABLE"
                          ? "No conflicts"
                          : "Checking…"}
                  </dd>
                </dl>
                {request.labels.nodes.length ? (
                  <p className={styles.labels}>
                    {request.labels.nodes.map((label) => label.name).join(" · ")}
                  </p>
                ) : null}
                <h3 className={styles.sectionLabel}>Description</h3>
                <div className={styles.markdown}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {detail.body || "No description provided."}
                  </ReactMarkdown>
                </div>
                <a href={safeGitHubUrl(request.url, hostname)} target="_blank" rel="noreferrer">
                  View checks and full conversation on GitHub
                </a>
              </>
            ) : tab === "Files" ? (
              <>
                <p>
                  {files.length} of {request.changedFiles} files · diff previews
                </p>
                {files.map((file) => (
                  <details className={styles.file} key={file.filename}>
                    <summary>
                      <code>{file.filename}</code>
                      <small>
                        {file.status} · <span className={styles.additions}>+{file.additions}</span>{" "}
                        <span className={styles.deletions}>−{file.deletions}</span>
                      </small>
                    </summary>
                    {file.patch ? (
                      <pre>
                        {file.patch.split("\n").map((line, index) => (
                          <span
                            key={index}
                            className={
                              line.startsWith("+")
                                ? styles.additions
                                : line.startsWith("-")
                                  ? styles.deletions
                                  : undefined
                            }
                          >
                            {line}
                            {"\n"}
                          </span>
                        ))}
                      </pre>
                    ) : (
                      <p>
                        No text preview. This file may be binary, too large, or unchanged after a
                        rename.
                      </p>
                    )}
                  </details>
                ))}
                {loadingFiles ? <p role="status">Loading files…</p> : null}
                {filesError ? (
                  <p role="alert">
                    {filesError}
                    <button type="button" onClick={() => void loadMore()}>
                      Retry files
                    </button>
                  </p>
                ) : null}
                {hasMoreFiles && filePage > 1 ? (
                  <button type="button" disabled={loadingFiles} onClick={() => void loadMore()}>
                    Load more files
                  </button>
                ) : null}
                <a
                  href={safeGitHubUrl(request.url + "/files", hostname)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open complete diff on GitHub
                </a>
              </>
            ) : (
              <>
                <p>
                  {(detail.comments.totalCount ?? 0) > 50 || (detail.reviews.totalCount ?? 0) > 50
                    ? "Showing the latest 50 reviews and 50 conversation comments. "
                    : "Reviews and conversation comments. "}
                  Open GitHub for inline discussions.
                </p>
                {!activity.length ? (
                  <p>No comments or reviews yet.</p>
                ) : (
                  activity.map((item) => (
                    <article className={styles.activity} key={item.id}>
                      <header>
                        <strong>{item.author?.login ?? "Deleted user"}</strong>
                        <time>{new Date(item.createdAt).toLocaleDateString()}</time>
                      </header>
                      {item.state ? <small>{item.state.replaceAll("_", " ")}</small> : null}
                      <div className={styles.markdown}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.body}</ReactMarkdown>
                      </div>
                    </article>
                  ))
                )}
              </>
            )}
          </div>
          <footer>
            <span>
              <small>{request.changedFiles} changed files</small>
              <span className={styles.additions}>+{request.additions}</span>{" "}
              <span className={styles.deletions}>−{request.deletions}</span>
            </span>
            <button
              type="button"
              disabled={detail.state !== "OPEN" || submitting}
              onClick={() => {
                setReview(detail);
                setEvent("COMMENT");
                setBody("");
                setReviewError(null);
              }}
            >
              Review…
            </button>
          </footer>
        </>
      )}
      <Dialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open && !submitting) setReview(null);
        }}
      >
        <DialogPopup showCloseButton={!submitting}>
          <DialogHeader>
            <DialogTitle>Review pull request</DialogTitle>
            <DialogDescription>
              {request.repository.nameWithOwner} #{request.number} · {request.title}
            </DialogDescription>
          </DialogHeader>
          <div className={styles.editor}>
            <label>
              Review
              <select
                value={event}
                disabled={submitting}
                onChange={(change) => setEvent(change.target.value as typeof event)}
              >
                <option value="APPROVE">Approve</option>
                <option value="REQUEST_CHANGES">Request changes</option>
                <option value="COMMENT">Comment</option>
              </select>
            </label>
            <textarea
              aria-label="Review comment"
              value={body}
              disabled={submitting}
              onChange={(change) => setBody(change.target.value)}
              rows={6}
              maxLength={65536}
            />
            <p>
              {event === "APPROVE"
                ? "Your approval will be attached to the revision you reviewed. A comment is optional."
                : "Explain your feedback. This review will be posted to GitHub."}
            </p>
            {validation ? <p role="status">{validation}</p> : null}
            {reviewError ? <p role="alert">{reviewError}</p> : null}
            <small>
              Reviewing {review?.headRefOid.slice(0, 7)} as {account}
            </small>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={submitting} onClick={() => setReview(null)}>
              Cancel
            </Button>
            <Button
              disabled={submitting || !!validation}
              onClick={() => {
                if (!review || submitting) return;
                setSubmitting(true);
                setReviewError(null);
                void run({ action: "review", ...identity, request, detail: review, event, body })
                  .then((result) => {
                    if (result.kind === "review" && result.submitted) {
                      setReview(null);
                      onReviewed();
                    }
                  })
                  .catch((cause) => setReviewError(errorMessage(cause)))
                  .finally(() => setSubmitting(false));
              }}
            >
              {submitting
                ? "Submitting…"
                : event === "COMMENT"
                  ? "Submit comment"
                  : "Submit review"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </aside>
  );
}
function errorMessage(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Could not complete this GitHub request. Retry when connected.";
}
function safeGitHubUrl(value: string, hostname: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === hostname && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
