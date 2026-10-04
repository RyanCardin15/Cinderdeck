import { createFileRoute } from "@tanstack/react-router";
import { ServicesRunsPage } from "../deckhand/ServicesRuns";
import { validateServicesSearch } from "../deckhand/servicesNavigation";
export const Route = createFileRoute("/_chat/services")({
  validateSearch: validateServicesSearch,
  component: ServicesRunsPage,
});
