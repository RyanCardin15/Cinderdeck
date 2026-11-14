// The production icon, as GitHub shows the Cinderdeck app, whatever this build's channel.
import appIconUrl from "../../../../assets/cinderdeck/prod/web-apple-touch-180.png";

export function CinderdeckAppIcon(props: { readonly className?: string }) {
  return <img src={appIconUrl} alt="" className={props.className} />;
}
