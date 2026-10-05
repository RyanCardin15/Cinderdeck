import Constants from "expo-constants";

const appVariant = Constants.expoConfig?.extra?.appVariant;

export const CINDERDECK_BRAND_MARK_SOURCE =
  appVariant === "development"
    ? require("../../../../assets/cinderdeck/dev/ios-1024.png")
    : appVariant === "preview"
      ? require("../../../../assets/cinderdeck/nightly/ios-1024.png")
      : require("../../../../assets/cinderdeck/prod/ios-1024.png");
