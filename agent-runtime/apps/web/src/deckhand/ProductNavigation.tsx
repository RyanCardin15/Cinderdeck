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
}) {
  const { context, tab: _tab, ...scope } = workspaceSearch ?? {};
  const operationSearch = { ...scope, ...(context ? { workspace: context } : {}) };
  return (
    <aside className={styles.rail} aria-label="Cinderdeck navigation">
      {window.desktopBridge ? <div className={styles.titlebar} aria-hidden="true" /> : null}
      <Link
        className={styles.brand}
        to="/workspaces"
        search={{ ...workspaceSearch, tab: "overview" }}
      >
        <CinderdeckMark aria-hidden="true" />
        <strong>Cinderdeck</strong>
      </Link>
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
          search={{ involvement: "all", state: "open", ...(workspaceSearch?.environment ? { environmentId: EnvironmentId.make(workspaceSearch.environment) } : {}) }}
          className={current === "pull-requests" ? styles.current : ""}
          aria-current={current === "pull-requests" ? "page" : undefined}
        >
          <PullRequestGlyph.pullRequest size={18} />
          Pull requests
        </Link>
        <Link
          to="/services"
          search={operationSearch}
          className={current === "services" ? styles.current : ""}
          aria-current={current === "services" ? "page" : undefined}
        >
          <ServerIcon size={18} />
          Services & runs
        </Link>
        <Link
          to="/recordings"
          search={operationSearch}
          className={current === "recordings" ? styles.current : ""}
          aria-current={current === "recordings" ? "page" : undefined}
        >
          <FilmIcon size={18} />
          Recordings
        </Link>
      </nav>
      {children}
      <div className={styles.bottom}>
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
