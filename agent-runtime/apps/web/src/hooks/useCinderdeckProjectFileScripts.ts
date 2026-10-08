import {
  CINDERDECK_PROJECT_FILE_NAME,
  type EnvironmentId,
  type CinderdeckProjectFile,
  type CinderdeckProjectFileScript,
} from "@cinderdeck/contracts";
import { parseCinderdeckProjectFile } from "@cinderdeck/shared/cinderdeckProjectFile";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<CinderdeckProjectFileScript> = [];

export interface CinderdeckProjectFileState {
  /**
   * - `valid`: t3.json exists and decoded.
   * - `invalid`: t3.json exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: no readable t3.json at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  /** The decoded file when status is `valid`, null otherwise. */
  file: CinderdeckProjectFile | null;
  scripts: ReadonlyArray<CinderdeckProjectFileScript>;
}

/**
 * Decoded state of the project's checked-in `t3.json`, including whether the
 * file exists but is broken — which the runtime otherwise swallows silently.
 */
export function useCinderdeckProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): CinderdeckProjectFileState {
  const query = useProjectFileQuery(environmentId, cwd ?? "", CINDERDECK_PROJECT_FILE_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  return useMemo(() => {
    if (contents === null) {
      return {
        status: isPending ? "loading" : "missing",
        file: null,
        scripts: NO_SCRIPTS,
      } as const;
    }
    const file = parseCinderdeckProjectFile(contents);
    if (file === null) {
      return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
    }
    return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
  }, [contents, isPending]);
}

/**
 * Scripts declared in the project's checked-in `t3.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useCinderdeckProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<CinderdeckProjectFileScript> {
  return useCinderdeckProjectFileState(environmentId, cwd).scripts;
}
