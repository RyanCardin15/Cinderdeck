import { Link } from "@tanstack/react-router";
import {
  ServerIcon,
  TerminalIcon,
  WorkflowIcon,
  PlaySquareIcon,
  CircleIcon,
  MessagesSquareIcon,
} from "lucide-react";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import type { WorkspaceSearch } from "./workspaceNavigation";
import styles from "./nativeWorkspace.module.css";
const sections = [
  { tab: "agents", label: "Sessions", Icon: MessagesSquareIcon },
  { tab: "services", label: "Services", Icon: ServerIcon },
  { tab: "tasks", label: "Tasks", Icon: TerminalIcon },
  { tab: "workflows", label: "Workflows", Icon: WorkflowIcon },
  { tab: "runs", label: "Runs", Icon: PlaySquareIcon },
  { tab: "recordings", label: "Recordings", Icon: CircleIcon },
  { tab: "pull-requests", label: "Pull requests", Icon: PullRequestGlyph.pullRequest },
] as const;
export function WorkspaceSections({ search }: { search: WorkspaceSearch }) {
  return (
    <nav className={styles.sections} aria-label="Views for selected context">
      {sections.map(({ tab, label, Icon }) => (
        <Link
          key={tab}
          to="/workspaces"
          search={{ ...search, tab }}
          aria-current={(search.tab ?? "overview") === tab ? "page" : undefined}
        >
          <Icon size={14} aria-hidden />
          {label}
        </Link>
      ))}
    </nav>
  );
}
