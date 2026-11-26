import {
  CINDERDECK_PROJECT_FILE_NAME,
  type EnvironmentId,
  type CinderdeckProjectFile,
} from "@cinderdeck/contracts";
import { parseCinderdeckProjectFile } from "@cinderdeck/shared/cinderdeckProjectFile";
import { executeAtomQuery } from "@cinderdeck/client-runtime/state/runtime";

import {
  getProjectFileQueryAtom,
  resolveProjectFileQueryData,
} from "~/components/files/projectFilesQueryState";
import { appAtomRegistry } from "~/rpc/atomRegistry";

export async function readCinderdeckProjectFile(
  environmentId: EnvironmentId,
  workspaceRoot: string,
): Promise<CinderdeckProjectFile | null> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    getProjectFileQueryAtom(environmentId, workspaceRoot, CINDERDECK_PROJECT_FILE_NAME),
    { reportDefect: false, reportFailure: false },
  );
  const data = resolveProjectFileQueryData(
    environmentId,
    workspaceRoot,
    CINDERDECK_PROJECT_FILE_NAME,
    result._tag === "Success" ? result.value : null,
  );
  if (data === null || data.exists === false || data.truncated) return null;
  return parseCinderdeckProjectFile(data.contents);
}
