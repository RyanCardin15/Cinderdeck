import type { SVGProps } from "react";

export function DeckhandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none">
      <path d="M5 4h6a8 8 0 0 1 0 16H5V4Z" stroke="currentColor" strokeWidth="2.5" />
      <path d="M9 8v8m4-8v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
