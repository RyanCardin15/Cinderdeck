import type { SVGProps } from "react";

/** The angular ember mark from Cinderdeck's native AppIcon, in a themeable silhouette. */
export function CinderdeckMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 32 36" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
      <path d="M5 10.4 16 4l11 6.4v4.4L16 8.4 5 14.8Z" />
      <path d="m5 15.8 7.4 4.3L5 24.4v4.4l11 6.4 11-6.4v-4.4l-11 6.4-7.4-4.3L17 21.6v-4.4L9.4 12.8Z" />
    </svg>
  );
}
