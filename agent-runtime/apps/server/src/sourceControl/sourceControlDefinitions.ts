import * as AzureDevOpsDriver from "@cinderdeck/source-control-azure-devops/server/driver";
import * as BitbucketDriver from "@cinderdeck/source-control-bitbucket/server/driver";
import { builtInSourceControlDefinitions } from "@cinderdeck/source-control-definitions/registry";
import * as ForgejoDriver from "@cinderdeck/source-control-forgejo/server/driver";
import * as GitCafeDriver from "@cinderdeck/source-control-gitcafe/server/driver";
import * as GitHubDriver from "@cinderdeck/source-control-github/server/driver";
import * as GitLabDriver from "@cinderdeck/source-control-gitlab/server/driver";

/** In the shared registry's order, which is the order hosts are listed and probed in. */
export const BUILT_IN_SOURCE_CONTROL_DRIVER_LIST = [
  GitHubDriver.driver,
  GitLabDriver.driver,
  GitCafeDriver.driver,
  ForgejoDriver.driver,
  BitbucketDriver.driver,
  AzureDevOpsDriver.driver,
] as const;

export const sourceControlDefinitions = builtInSourceControlDefinitions;
