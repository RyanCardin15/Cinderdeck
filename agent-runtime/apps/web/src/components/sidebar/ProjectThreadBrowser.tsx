import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { CheckIcon, SearchIcon } from "lucide-react";
import { useRef, useState } from "react";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useOlderSettledShelf, useOlderSettledShelfGrowth } from "../../state/olderSettledShelf";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { sidebarFolderRowId } from "./SidebarProjectFolderHeader";

export const PROJECT_THREAD_LIMIT = 10;
const PAGE_SIZE = 50;

export function ProjectThreadBrowser({
  group,
  threads,
  onOpenThread,
}: {
  group: SidebarProjectSnapshot;
  threads: readonly EnvironmentThreadShell[];
  onOpenThread: (ref: ScopedThreadRef) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const term = query.trim().toLocaleLowerCase();
  const matches = term
    ? threads.filter((thread) => thread.title.toLocaleLowerCase().includes(term))
    : threads;
  const scopes = [...new Set(group.memberProjectRefs.map((ref) => ref.environmentId))].map(
    (environmentId) => ({
      environmentId,
      projectIds: group.memberProjectRefs
        .filter((ref) => ref.environmentId === environmentId)
        .map((ref) => ref.projectId),
    }),
  );
  const history = useOlderSettledShelf({
    scopes,
    expanded: true,
    visibleCount: open ? limit : PROJECT_THREAD_LIMIT,
  });
  const hasOlderPage = [...history.environments.values()].some(
    ({ older, pages }) => older !== null && pages.frontier !== null,
  );
  const missing = hasOlderPage ? history.unloadedCount(threads) : 0;
  // Search walks older pages in this project until it fills a page of matches or reaches the end.
  useOlderSettledShelfGrowth(
    { ...history, visibleCount: missing > 0 ? history.visibleCount : 0 },
    missing > 0
      ? matches.filter((row) => row.settledOverride !== "settled" || history.isListed(row))
      : matches,
  );
  const more = threads.length + missing > PROJECT_THREAD_LIMIT;
  if (!open && !more && !history.failed) return null;
  const close = () => {
    setOpen(false);
    setQuery("");
    setLimit(PAGE_SIZE);
  };
  const parent = sidebarFolderRowId(group.projectKey);
  return (
    <li className="list-none">
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-label={`Show more threads in ${group.displayName}`}
        data-sidebar-row={`${parent}:more`}
        data-sidebar-parent={parent}
        className="h-8 w-full cursor-pointer rounded-md pl-9 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        onClick={() => setOpen(true)}
      >
        Show more
      </button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
      >
        <DialogPopup
          className="h-[min(36rem,80dvh)] max-w-2xl"
          initialFocus={input}
          finalFocus={trigger}
        >
          <DialogHeader>
            <DialogTitle>{group.displayName} threads</DialogTitle>
            <label className="mt-2 flex items-center gap-2 rounded-lg border bg-background px-3 focus-within:border-ring">
              <SearchIcon className="size-4 text-muted-foreground" aria-hidden />
              <input
                ref={input}
                type="search"
                aria-label="Search project threads"
                placeholder="Search threads by title…"
                className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setLimit(PAGE_SIZE);
                }}
              />
            </label>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4" aria-label="Project threads">
            {matches.slice(0, limit).map((thread) => {
              const ref = scopeThreadRef(thread.environmentId, thread.id);
              return (
                <button
                  type="button"
                  key={scopedThreadKey(ref)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    onOpenThread(ref);
                    close();
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{thread.title || "New thread"}</span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {thread.settledOverride === "settled" ? (
                      <>
                        <CheckIcon className="size-3" />
                        Settled
                      </>
                    ) : (
                      "Unsettled"
                    )}
                  </span>
                </button>
              );
            })}
            {history.failed ? (
              <button type="button" className="p-3 text-sm" onClick={history.retry}>
                Retry loading older threads
              </button>
            ) : history.loading || (missing > 0 && matches.length < limit) ? (
              <p role="status" className="p-3 text-sm text-muted-foreground">
                Loading older threads…
              </p>
            ) : !matches.length ? (
              <p role="status" className="p-3 text-sm text-muted-foreground">
                No matching threads
              </p>
            ) : null}
            {matches.length > limit || (matches.length >= limit && missing > 0) ? (
              <button
                type="button"
                className="p-3 text-sm"
                onClick={() => setLimit(limit + PAGE_SIZE)}
              >
                Show more results
              </button>
            ) : null}
          </div>
        </DialogPopup>
      </Dialog>
    </li>
  );
}
