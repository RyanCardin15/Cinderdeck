import type { ModelSelection, UnifiedSettings } from "@cinderdeck/contracts";
import { resolveSelectableModel } from "@cinderdeck/shared/model";
import { getAppModelOptionsForInstance, type AppModelOption } from "../../modelSelection";
import {
  getDefaultProviderInstanceModel,
  type ProviderInstanceEntry,
} from "../../providerInstances";

export function resolveCapturePromptModels(input: {
  readonly provider: ProviderInstanceEntry | undefined;
  readonly settings: UnifiedSettings;
  readonly projectDefault: ModelSelection | null;
  readonly rememberedModel: string | null;
}): { readonly options: ReadonlyArray<AppModelOption>; readonly selection: ModelSelection | null } {
  const { provider, projectDefault, settings, rememberedModel } = input;
  if (!provider) return { options: [], selection: null };

  const options = getAppModelOptionsForInstance(settings, provider).filter(
    (option) => !option.isUnavailable,
  );
  // Some harnesses expose an implicit default without publishing a model catalog.
  if (options.length === 0 && provider.models.length === 0) {
    const slug = getDefaultProviderInstanceModel([provider.snapshot], provider.instanceId);
    if (slug) options.push({ slug, name: "Harness default", isCustom: false, isDefault: true });
  }

  const projectSelection =
    projectDefault?.instanceId === provider.instanceId ? projectDefault : null;
  const projectModel = resolveSelectableModel(
    provider.driverKind,
    projectSelection?.model,
    options,
  );
  const model =
    resolveSelectableModel(provider.driverKind, rememberedModel, options) ??
    projectModel ??
    options.find((option) => option.isDefault)?.slug ??
    options[0]?.slug;
  if (!model) return { options, selection: null };

  return {
    options,
    selection: {
      instanceId: provider.instanceId,
      model,
      ...(model === projectModel && projectSelection?.options
        ? { options: projectSelection.options }
        : {}),
    },
  };
}
