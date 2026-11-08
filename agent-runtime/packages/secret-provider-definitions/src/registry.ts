import { makeSecretProviderDefinitionRegistry } from "@cinderdeck/secret-provider-core/shared/definition";
import * as OnePassword from "@cinderdeck/secret-provider-onepassword/shared/definition";

export const builtInSecretProviderDefinitions = makeSecretProviderDefinitionRegistry([
  OnePassword.definition,
]);
