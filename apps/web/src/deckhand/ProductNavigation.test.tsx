import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import type { ReactNode } from "react";
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    className,
    ...props
  }: {
    to: string;
    children: ReactNode;
    className?: string;
    "aria-current"?: "page";
  }) => (
    <a href={to} className={className} aria-current={props["aria-current"]}>
      {children}
    </a>
  ),
}));
vi.mock("../components/pullRequest/pullRequestListPreferences", () => ({
  readPullRequestListPreferences: () => ({}),
}));
import { ProductNavigation } from "./ProductNavigation";
it("exposes one Deckhand rail with the current pull-request destination and all product recovery links", () => {
  const html = renderToStaticMarkup(<ProductNavigation current="pull-requests" />);
  expect(html.match(/aria-label="Deckhand navigation"/g)).toHaveLength(1);
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(html).toMatch(/href="\/pull-requests"[^>]*aria-current="page"/);
  for (const destination of ["/workspaces", "/inbox", "/", "/services", "/recordings", "/settings"])
    expect(html).toContain(`href="${destination}"`);
});
