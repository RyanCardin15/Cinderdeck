import {
  T3_PROJECT_FILE_NAME,
  type EnvironmentId,
  type CinderdeckProjectFile,
  type CinderdeckProjectFileScript,
} from "@cinderdeck/contracts";
import { parseT3ProjectFile } from "@cinderdeck/shared/cinderdeckProjectFile";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<CinderdeckProjectFileScript> = [];

export interface CinderdeckProjectFileState {
  status: "loading" | "missing" | "invalid" | "valid";
  file: CinderdeckProjectFile | null;
  scripts: ReadonlyArray<CinderdeckProjectFileScript>;
}

export function useT3ProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): CinderdeckProjectFileState {
  const query = useProjectFileQuery(environmentId, cwd ?? "", T3_PROJECT_FILE_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  if (contents === null) {
    return {
      status: isPending ? "loading" : "missing",
      file: null,
      scripts: NO_SCRIPTS,
    } as const;
  }
  const file = parseT3ProjectFile(contents);
  if (file === null) {
    return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
  }
  return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
}

export function useT3ProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<CinderdeckProjectFileScript> {
  return useT3ProjectFileState(environmentId, cwd).scripts;
}
