import type { NativeSettingValue, NativeSettingsField } from "@cinderdeck/contracts";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import {
  SettingsRow,
  SettingsSearchTarget,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { settingLabel } from "./nativeSettingsPresentation";
import styles from "./NativeSettings.module.css";

const menuGroup = (item: string) =>
  item === "checkForUpdates"
    ? 3
    : item.startsWith("record")
      ? 1
      : item.startsWith("capture") || item === "scrollingCapture"
        ? 0
        : 2;

export function NativeMenuItems({
  fields,
  draft,
  disabled,
  onChange,
}: {
  fields: readonly NativeSettingsField[];
  draft: Readonly<Record<string, NativeSettingValue>>;
  disabled: boolean;
  onChange: (id: string, value: NativeSettingValue) => void;
}) {
  const orderField = fields.find((field) => field.id === "menu_bar.item_order");
  const hiddenField = fields.find((field) => field.id === "menu_bar.hidden_items");
  if (!orderField || !hiddenField) return null;
  const order = draft[orderField.id] ?? orderField.value;
  const hidden = draft[hiddenField.id] ?? hiddenField.value;
  if (!Array.isArray(order) || !Array.isArray(hidden)) return null;
  const items = [...new Set([...order, ...(orderField.options ?? [])])].sort(
    (a, b) => menuGroup(a) - menuGroup(b),
  );
  return (
    <SettingsSearchTarget id="native-menu_bar.hidden_items">
      <SettingsSection title="Menu items" id="native-menu_bar.item_order">
        <p className="px-4 pt-3 text-xs text-muted-foreground">
          Choose which actions appear, and arrange their order within each menu group.
        </p>
        {items.map((item, index) => (
          <SettingsRow
            key={item}
            title={settingLabel(item)}
            control={
              <div className={styles.actions}>
                {[-1, 1].map((direction) => (
                  <Button
                    key={direction}
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move ${settingLabel(item)} ${direction < 0 ? "up" : "down"}`}
                    disabled={
                      disabled ||
                      index + direction < 0 ||
                      index + direction >= items.length ||
                      item === "checkForUpdates" ||
                      menuGroup(item) !== menuGroup(items[index + direction] ?? "")
                    }
                    onClick={() => {
                      const next = [...items];
                      [next[index], next[index + direction]] = [
                        next[index + direction]!,
                        next[index]!,
                      ];
                      onChange(orderField.id, next);
                    }}
                  >
                    {direction < 0 ? <ArrowUpIcon size={12} /> : <ArrowDownIcon size={12} />}
                  </Button>
                ))}
                <Switch
                  aria-label={`Show ${settingLabel(item)} in the menu bar`}
                  checked={!hidden.includes(item)}
                  disabled={disabled}
                  onCheckedChange={(visible) =>
                    onChange(
                      hiddenField.id,
                      visible ? hidden.filter((value) => value !== item) : [...hidden, item],
                    )
                  }
                />
              </div>
            }
          />
        ))}
      </SettingsSection>
    </SettingsSearchTarget>
  );
}
