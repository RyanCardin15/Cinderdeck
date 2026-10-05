import { EnvironmentId } from "@t3tools/contracts";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  ServerIcon,
  LayersIcon,
  InboxIcon,
  MessagesSquareIcon,
  FilmIcon,
  SettingsIcon,
} from "lucide-react";
import { CinderdeckMark } from "./CinderdeckMark";
import { NativeToolsMenu } from "./NativeToolsSettings";
import styles from "./navigation.module.css";
import type { WorkspaceSearch } from "./workspaceNavigation";
export function ProductNavigation({
  current,
  children,
  connection,
  workspaceSearch,
  workspaceMode = false,
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
  workspaceMode?: boolean;
}) {
  const scoped = Boolean(workspaceSearch?.workspace || workspaceSearch?.context);
  const links = (
    <nav className={styles.links}>
      <Link
        to="/workspaces"
        search={{ ...workspaceSearch, tab: "overview" }}
        className={current === "workspaces" ? styles.current : ""}
        aria-current={current === "workspaces" ? "page" : undefined}
      >
        <LayersIcon size={18} />
        Overview
      </Link>
      <Link
        to="/inbox"
        className={current === "inbox" ? styles.current : ""}
        aria-current={current === "inbox" ? "page" : undefined}
      >
        <InboxIcon size={18} />
        Inbox
      </Link>
      <Link
        to="/workspaces"
        search={{ ...workspaceSearch, tab: "agents" }}
        className={current === "conversations" ? styles.current : ""}
        aria-current={current === "conversations" ? "page" : undefined}
      >
        <MessagesSquareIcon size={18} />
        Agents
      </Link>
      <Link
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
        Pull requests
      </Link>
      <Link
        to={scoped ? "/workspaces" : "/services"}
        search={scoped ? { ...workspaceSearch, tab: "services" } : (workspaceSearch ?? {})}
        className={current === "services" ? styles.current : ""}
        aria-current={current === "services" ? "page" : undefined}
      >
        <ServerIcon size={18} />
        Services & runs
      </Link>
      <Link
        to={scoped ? "/workspaces" : "/recordings"}
        search={scoped ? { ...workspaceSearch, tab: "recordings" } : (workspaceSearch ?? {})}
        className={current === "recordings" ? styles.current : ""}
        aria-current={current === "recordings" ? "page" : undefined}
      >
        <FilmIcon size={18} />
        Recordings
      </Link>
    </nav>
  );
  return (
    <aside className={styles.rail} aria-label="Cinderdeck navigation">
      {window.desktopBridge ? <div className={styles.titlebar} aria-hidden="true" /> : null}
      <Link
        className={styles.brand}
        to="/workspaces"
        search={{ ...workspaceSearch, tab: "overview" }}
      >
        <CinderdeckMark aria-hidden="true" />
        <span>
          <strong>Cinderdeck</strong>
          {workspaceMode ? <small>Workspaces</small> : null}
        </span>
      </Link>
      {!workspaceMode ? links : null}
      {children}
      <div className={styles.bottom}>
        {workspaceMode ? (
          <details className={styles.allViews}>
            <summary>All views</summary>
            {links}
          </details>
        ) : null}
        <NativeToolsMenu className={styles.tools} />
        <Link to="/settings" aria-current={current === "settings" ? "page" : undefined}>
          <SettingsIcon size={17} />
          Settings
        </Link>
        {connection ? (
          <p data-connected={connection.connected}>
            <i />
            {connection.label}
          </p>
        ) : null}
      </div>
    </aside>
  );
}
