import {
  connectionStatusText,
  type EnvironmentConnectionPresentation,
} from "@cinderdeck/client-runtime/connection";

export function environmentStatusText(connection: EnvironmentConnectionPresentation): string {
  return connection.phase === "unsupported" && connection.error !== null
    ? connection.error
    : connectionStatusText(connection);
}
