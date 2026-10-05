import { Link } from "@tanstack/react-router";
import {
  ServerIcon,
  TerminalIcon,
  WorkflowIcon,
  GitBranchIcon,
  PlaySquareIcon,
  CircleIcon,
  MessagesSquareIcon,
} from "lucide-react";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import type { WorkspaceSearch } from "./workspaceNavigation";
import styles from "./nativeWorkspace.module.css";
const sections = [
  { tab: "services", label: "Services", Icon: ServerIcon },
  { tab: "tasks", label: "Tasks", Icon: TerminalIcon },
  { tab: "workflows", label: "Workflows", Icon: WorkflowIcon },
  { tab: "lane-map", label: "Lane map", Icon: GitBranchIcon },
  { tab: "runs", label: "Runs", Icon: PlaySquareIcon },
  { tab: "recordings", label: "Recordings", Icon: CircleIcon },
  { tab: "agents", label: "Agents", Icon: MessagesSquareIcon },
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
