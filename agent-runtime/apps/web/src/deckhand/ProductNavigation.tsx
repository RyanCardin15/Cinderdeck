import { EnvironmentId } from "@cinderdeck/contracts";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  ServerIcon,
  LayersIcon,
  InboxIcon,
  MessagesSquareIcon,
  FilmIcon,
  SettingsIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
} from "lucide-react";
import { CinderdeckMark } from "./CinderdeckMark";
import { useResizeDrag } from "../hooks/useResizeDrag";
import {
  useProductSidebar,
  PRODUCT_SIDEBAR_MIN_WIDTH,
  PRODUCT_SIDEBAR_MAX_WIDTH,
} from "./ProductSidebarLayout";
import { ProductWorkspaces } from "./ProductWorkspaces";
import { NativeToolsMenu } from "./NativeToolsSettings";
import styles from "./navigation.module.css";
import type { WorkspaceSearch } from "./workspaceNavigation";
export function ProductNavigation({
  current,
  children,
  connection,
  workspaceSearch,
  hasWorkspaceTree = false,
}: {
  current:
    | "workspaces"
    | "inbox"
    | "recordings"
    | "services"
    | "conversations"
    | "pull-requests"
    | "settings";
  children?: ReactNode;
  connection?: { label: string; connected: boolean };
  workspaceSearch?: WorkspaceSearch;
  hasWorkspaceTree?: boolean;
}) {
  const sidebar = useProductSidebar();
  const { readScrollTop } = sidebar;
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = readScrollTop();
  }, [readScrollTop]);
  const globalSearch = workspaceSearch?.environment
    ? { environment: workspaceSearch.environment }
    : {};
  const resize = useResizeDrag<HTMLDivElement>(() => {
    if (sidebar.collapsed || window.innerWidth <= 700) return null;
    return { width: sidebar.width, edge: "right", resize: sidebar.resize, finish: () => {} };
  }, String(sidebar.collapsed));
  const links = (
    <nav className={styles.links} aria-label="Main views">
      <Link
        to="/workspaces"
        title="Overview"
        search={{ ...globalSearch, tab: "overview" }}
        className={current === "workspaces" ? styles.current : ""}
        aria-current={current === "workspaces" ? "page" : undefined}
      >
        <LayersIcon size={18} />
        <span>Overview</span>
      </Link>
      <Link
        title="Inbox"
        to="/inbox"
        className={current === "inbox" ? styles.current : ""}
        aria-current={current === "inbox" ? "page" : undefined}
      >
        <InboxIcon size={18} />
        <span>Inbox</span>
      </Link>
      <Link
        to="/workspaces"
        title="Agents"
        search={{ tab: "agents" }}
        className={current === "conversations" ? styles.current : ""}
        aria-current={current === "conversations" ? "page" : undefined}
      >
        <MessagesSquareIcon size={18} />
        <span>Agents</span>
      </Link>
      <Link
        title="Pull requests"
        to="/pull-requests"
        search={{
          involvement: "all",
          state: "open",
          ...(workspaceSearch?.environment
            ? { environmentId: EnvironmentId.make(workspaceSearch.environment) }
            : {}),
        }}
        className={current === "pull-requests" ? styles.current : ""}
        aria-current={current === "pull-requests" ? "page" : undefined}
      >
        <PullRequestGlyph.pullRequest size={18} />
        <span>Pull requests</span>
      </Link>
      <Link
        title="Services & runs"
        to="/services"
        search={globalSearch}
        className={current === "services" ? styles.current : ""}
        aria-current={current === "services" ? "page" : undefined}
      >
        <ServerIcon size={18} />
        <span>Services & runs</span>
      </Link>
      <Link
        title="Recordings"
        to="/recordings"
        search={globalSearch}
        className={current === "recordings" ? styles.current : ""}
        aria-current={current === "recordings" ? "page" : undefined}
      >
        <FilmIcon size={18} />
        <span>Recordings</span>
      </Link>
    </nav>
  );
  return (
    <aside
      className={styles.rail}
      data-collapsed={sidebar.collapsed}
      aria-label="Cinderdeck navigation"
    >
      <div
        className={styles.scroll}
        ref={scrollRef}
        onScroll={(event) => {
          sidebar.rememberScrollTop(event.currentTarget.scrollTop);
        }}
      >
        {window.desktopBridge ? <div className={styles.titlebar} aria-hidden="true" /> : null}
        <div className={styles.brandRow}>
          <Link
            className={styles.brand}
            to="/workspaces"
            search={{ ...globalSearch, tab: "overview" }}
            aria-label="Cinderdeck overview"
          >
            <CinderdeckMark aria-hidden="true" />
            <strong>Cinderdeck</strong>
          </Link>
          <button
            type="button"
            className={styles.toggle}
            onClick={sidebar.toggle}
            aria-label={sidebar.collapsed ? "Expand main sidebar" : "Collapse main sidebar"}
            aria-expanded={!sidebar.collapsed}
          >
            {sidebar.collapsed ? <PanelLeftOpenIcon size={17} /> : <PanelLeftCloseIcon size={17} />}
          </button>
        </div>
        {links}
        <div className={styles.workspaces} hidden={sidebar.collapsed}>
          {children}
          {!hasWorkspaceTree ? <ProductWorkspaces search={workspaceSearch} /> : null}
        </div>
        <div className={styles.bottom}>
          <div hidden={sidebar.collapsed}>
            <NativeToolsMenu className={styles.tools} />
          </div>
          <Link
            to="/settings"
            aria-current={current === "settings" ? "page" : undefined}
            title="Settings"
          >
            <SettingsIcon size={17} />
            <span>Settings</span>
          </Link>
          {connection && !sidebar.collapsed ? (
            <p data-connected={connection.connected}>
              <i />
              {connection.label}
            </p>
          ) : null}
        </div>
      </div>
      {!sidebar.collapsed ? (
        <div
          className={styles.resize}
          role="separator"
          tabIndex={0}
          aria-label="Resize main sidebar"
          aria-orientation="vertical"
          aria-valuemin={PRODUCT_SIDEBAR_MIN_WIDTH}
          aria-valuemax={PRODUCT_SIDEBAR_MAX_WIDTH}
          aria-valuenow={sidebar.width}
          aria-description="Drag to resize. Double-click to reset."
          {...resize}
          onDoubleClick={sidebar.reset}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              sidebar.resize(sidebar.width + (event.key === "ArrowLeft" ? -16 : 16));
            } else if (event.key === "Home") {
              event.preventDefault();
              sidebar.resize(PRODUCT_SIDEBAR_MIN_WIDTH);
            } else if (event.key === "End") {
              event.preventDefault();
              sidebar.resize(PRODUCT_SIDEBAR_MAX_WIDTH);
            }
          }}
        />
      ) : null}
    </aside>
  );
}
