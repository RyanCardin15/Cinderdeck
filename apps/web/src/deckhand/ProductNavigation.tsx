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
import { readPullRequestListPreferences } from "../components/pullRequest/pullRequestListPreferences";
import { DeckhandMark } from "./DeckhandMark";
import styles from "./navigation.module.css";
export function ProductNavigation({
  current,
  children,
  connection,
}: {
  current: "workspaces" | "inbox" | "recordings" | "services" | "conversations" | "pull-requests";
  children?: ReactNode;
  connection?: { label: string; connected: boolean };
}) {
  return (
    <aside className={styles.rail} aria-label="Deckhand navigation">
      <Link className={styles.brand} to="/workspaces">
        <DeckhandMark aria-hidden="true" />
        <strong>Deckhand</strong>
      </Link>
      <nav className={styles.links}>
        <Link
          to="/workspaces"
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
          to="/"
          className={current === "conversations" ? styles.current : ""}
          aria-current={current === "conversations" ? "page" : undefined}
        >
          <MessagesSquareIcon size={18} />
          Conversations
        </Link>
        <Link
          to="/pull-requests"
          search={readPullRequestListPreferences()}
          className={current === "pull-requests" ? styles.current : ""}
          aria-current={current === "pull-requests" ? "page" : undefined}
        >
          <PullRequestGlyph.pullRequest size={18} />
          Pull requests
        </Link>
        <Link
          to="/services"
          className={current === "services" ? styles.current : ""}
          aria-current={current === "services" ? "page" : undefined}
        >
          <ServerIcon size={18} />
          Services & runs
        </Link>
        <Link
          to="/recordings"
          className={current === "recordings" ? styles.current : ""}
          aria-current={current === "recordings" ? "page" : undefined}
        >
          <FilmIcon size={18} />
          Recordings
        </Link>
      </nav>
      {children}
      <div className={styles.bottom}>
        {connection ? (
          <p data-connected={connection.connected}>
            <i />
            {connection.label}
          </p>
        ) : null}
        <Link to="/settings">
          <SettingsIcon size={17} />
          Settings
        </Link>
      </div>
    </aside>
  );
}
