import type { PullRequestDetailTab } from "../components/pullRequest/PullRequestDetailPanel";
export type PullRequestDetailFocus = {
  readonly surfaceId: string;
  readonly tab: PullRequestDetailTab;
  readonly browsing: boolean;
} | null;
export function updatePullRequestDetailFocus(
  previous: PullRequestDetailFocus,
  surfaceId: string,
  tab: PullRequestDetailTab,
): PullRequestDetailFocus {
  return previous?.surfaceId === surfaceId && previous.tab === tab
    ? previous
    : { surfaceId, tab, browsing: false };
}
export function pullRequestEvidenceFocused(
  state: PullRequestDetailFocus,
  surfaceId: string | null,
): boolean {
  return (
    surfaceId !== null &&
    state?.surfaceId === surfaceId &&
    state.tab === "verification" &&
    !state.browsing
  );
}
