import { resolveFilesystemReadAccess } from "@cinderdeck/client-runtime/state/filesystem";
import { isScratchProject } from "@cinderdeck/client-runtime/state/projects";
import type { EnvironmentProject } from "@cinderdeck/client-runtime/state/shell";
import type { ProjectReadFileResult } from "@cinderdeck/contracts";
import { DEFAULT_SERVER_SETTINGS, CINDERDECK_PROJECT_FILE_NAME } from "@cinderdeck/contracts";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@cinderdeck/shared/projectSettings";
import { parseCinderdeckProjectFile } from "@cinderdeck/shared/cinderdeckProjectFile";

import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useProjectHasThreads } from "../../state/project-has-threads";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession } from "../../state/session";

/**
 * A project's new-task defaults: server settings merged with its t3.json. The
 * new-task flow and the home pending-drafts list both read the default
 * workspace mode here, so a draft that never picked one shows what it sends.
 * Every read is a shared per-environment or per-project atom.
 */
export function useNewTaskProjectDefaults(project: EnvironmentProject | null) {
  const serverConfig = useEnvironmentServerConfig(project?.environmentId ?? null);
  const isScratch =
    project !== null && isScratchProject(project, serverConfig?.scratchWorkspaceRoot);
  const hasWorkspace = project !== null && project.workspaceRoot !== "";
  const fileAccessSession = useEnvironmentQuery(
    hasWorkspace ? environmentSession.sessionStateAtom(project.environmentId) : null,
  );
  const fileEnvironment = useEnvironmentPresentation(project?.environmentId ?? null);
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: fileEnvironment.isReady,
    connection: fileEnvironment.presentation?.connection ?? null,
    session: fileAccessSession.data,
    sessionError: fileAccessSession.error,
  });
  const fileAccessPending = hasWorkspace && fileAccess.isPending;
  const cinderdeckProjectFileQuery = useEnvironmentQuery(
    fileAccess.canReadFiles && hasWorkspace
      ? projectEnvironment.readFile({
          environmentId: project.environmentId,
          input: {
            cwd: project.workspaceRoot,
            relativePath: CINDERDECK_PROJECT_FILE_NAME,
            allowMissing: true,
          },
        })
      : null,
  );
  const cinderdeckProjectFileData = cinderdeckProjectFileQuery.data as ProjectReadFileResult | null;
  const cinderdeckProjectFile =
    cinderdeckProjectFileData === null || cinderdeckProjectFileData.exists === false || cinderdeckProjectFileData.truncated
      ? null
      : parseCinderdeckProjectFile(cinderdeckProjectFileData.contents);
  const projectSettings = resolveProjectSettings(
    serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
    project?.id ?? null,
    project,
    cinderdeckProjectFile,
  );
  const projectHasThreads = useProjectHasThreads(project);
  const defaultWorkspaceMode = isScratch
    ? "local"
    : resolveNewThreadEnvMode({
        projectSettings,
        workspaceRoot: project?.workspaceRoot ?? null,
        newProjectsRoot: serverConfig?.newProjectsRoot,
        projectHasThreads,
      });
  // While t3.json loads, the environment default is provisional; t3.json may replace it.
  const defaultWorkspaceModeSettled =
    projectSettings.sources.defaultThreadEnvMode !== "environment" ||
    (!cinderdeckProjectFileQuery.isPending && !fileAccessPending);
  return {
    serverConfig,
    isScratch,
    projectSettings,
    defaultWorkspaceMode,
    defaultWorkspaceModeSettled,
  };
}
