import { Image } from "expo-image";

import { CINDERDECK_BRAND_MARK_SOURCE } from "./brandAssets";

export function CinderdeckMark(props: { readonly height: number }) {
  return (
    <Image
      source={CINDERDECK_BRAND_MARK_SOURCE}
      accessibilityLabel="Cinderdeck"
      accessibilityIgnoresInvertColors
      style={{ width: props.height, height: props.height }}
    />
  );
}
