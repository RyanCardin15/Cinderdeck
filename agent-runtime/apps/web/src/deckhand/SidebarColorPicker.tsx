import { CheckIcon, RotateCcwIcon } from "lucide-react";
import type { RefObject } from "react";
import { Popover, PopoverPopup, PopoverTitle } from "../components/ui/popover";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../components/ui/tooltip";
import { isSidebarColor } from "./workspaceSidebarPreferences";
import styles from "./SidebarColorPicker.module.css";

const palette = [
  { name: "Ember", value: "#ed854a" },
  { name: "Amber", value: "#dca537" },
  { name: "Lime", value: "#9ab64b" },
  { name: "Green", value: "#51b57c" },
  { name: "Teal", value: "#43b3ad" },
  { name: "Blue", value: "#579de5" },
  { name: "Indigo", value: "#8285e8" },
  { name: "Violet", value: "#b18ae5" },
  { name: "Pink", value: "#de83b2" },
  { name: "Rose", value: "#e47880" },
];

export function SidebarColorPicker({
  open,
  onOpenChange,
  anchor,
  label,
  color,
  onChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: RefObject<HTMLDivElement | null>;
  label: string;
  color: string | undefined;
  onChange: (color: string | undefined) => void;
}) {
  const choose = (value: string | undefined) => {
    onChange(value);
    onOpenChange(false);
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverPopup
        anchor={anchor}
        side="right"
        align="start"
        sideOffset={8}
        padding="compact"
        width="sm"
        aria-label={`Highlight color for ${label}`}
        finalFocus={() => anchor.current?.querySelector("a") ?? false}
      >
        <div className={styles.picker}>
          <div className={styles.header}>
            <PopoverTitle>Highlight color</PopoverTitle>
            <span className={styles.target}>{label}</span>
          </div>
          <div className={styles.palette} role="group" aria-label="Preset colors">
            {palette.map((swatch) => (
              <Tooltip key={swatch.value}>
                <TooltipTrigger
                  render={<button type="button" />}
                  className={styles.swatch}
                  style={{ backgroundColor: swatch.value }}
                  aria-label={swatch.name}
                  aria-pressed={color?.toLowerCase() === swatch.value}
                  onClick={() => choose(swatch.value)}
                >
                  {color?.toLowerCase() === swatch.value ? (
                    <CheckIcon size={15} aria-hidden />
                  ) : null}
                </TooltipTrigger>
                <TooltipPopup>{swatch.name}</TooltipPopup>
              </Tooltip>
            ))}
          </div>
          <div className={styles.footer}>
            <button
              type="button"
              className={styles.reset}
              aria-pressed={!color}
              onClick={() => choose(undefined)}
            >
              <RotateCcwIcon size={12} aria-hidden />
              Use default
            </button>
            <label className={styles.custom}>
              <input
                type="color"
                aria-label={`Custom highlight color for ${label}`}
                value={color ?? palette[0]!.value}
                onChange={(event) => {
                  if (isSidebarColor(event.target.value)) onChange(event.target.value);
                }}
              />
              Custom…
            </label>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
