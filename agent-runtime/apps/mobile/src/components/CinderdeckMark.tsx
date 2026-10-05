import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function CinderdeckMark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  return (
    <Svg accessibilityLabel="Cinderdeck" height={props.height} width={props.height * 32 / 36} viewBox="0 0 32 36">
      <ThemedPath d="M5 10.4 16 4l11 6.4v4.4L16 8.4 5 14.8Z M5 15.8l7.4 4.3L5 24.4v4.4l11 6.4 11-6.4v-4.4l-11 6.4-7.4-4.3L17 21.6v-4.4L9.4 12.8Z" color={props.color} colorClassName={props.colorClassName} fill="currentColor" />
    </Svg>
  );
}
