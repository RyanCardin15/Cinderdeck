import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/_chat/external-apps")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/external-apps", replace: true });
  },
});
