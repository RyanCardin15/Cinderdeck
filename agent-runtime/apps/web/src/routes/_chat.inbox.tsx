import { createFileRoute } from "@tanstack/react-router";
import { Inbox } from "../deckhand/Inbox";
export const Route = createFileRoute("/_chat/inbox")({ component: Inbox });
