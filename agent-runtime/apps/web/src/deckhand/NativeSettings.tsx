import { randomUUID } from "../lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useBlocker } from "@tanstack/react-router";
import type {
  NativeSettingValue,
  NativeSettingsCategory,
  NativeSettingsCommand,
  NativeSettingsField,
  NativeSettingsSnapshot,
} from "@cinderdeck/contracts";
import { ArrowDownIcon, ArrowUpIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  SettingsSearchTarget,
  useSettingsSearchTargetId,
} from "../components/settings/settingsLayout";
import { NATIVE_SETTINGS_PAGES, type NativeSettingsPath } from "./nativeSettingsNavigation";
import styles from "./NativeSettings.module.css";
import { NativeMenuItems } from "./NativeMenuItems";

import {
  isNativeSettingsHost,
  nativeSettingsGroupLabel,
  settingLabel,
} from "./nativeSettingsPresentation";
export { isNativeSettingsHost } from "./nativeSettingsPresentation";
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const descriptions: Record<string, string> = {
  "general.export_location": "Choose where screenshots and recordings are saved.",
  "history.clipboard_text_enabled": "Keep copied text in local clipboard history.",
  "history.retention_days": "Use 0 to keep captures indefinitely.",
  "stacks.auto_fetch_minutes": "Use 0 to turn off automatic Git fetches.",
  "stacks.directory": "Changes apply when Cinderdeck next starts.",
  "stacks.lanes_directory":
    "The folder for new lane worktrees; existing lanes keep their locations.",
  "dictation.endpoint": "Audio is sent to this address only when you finish dictating.",
  "dictation.on_device_only": "Keep speech on this Mac. Requires a supported language.",
  "dictation.native_language": "Leave empty to use the system language.",
  "dictation.language": "Optional language code, such as en.",
  "dictation.shortcut_key": "Leave empty for a modifier-only shortcut, such as holding Control.",
  "shortcuts.enabled": "Allow global capture shortcuts outside Cinderdeck.",
};
const localOptions: Record<string, readonly string[]> = {
  "dictation.provider": ["service", "macOS"],
  "dictation.format": ["openAI", "elevenLabs"],
  "dictation.authentication": ["bearer", "header", "none"],
};

export function nativeSettingsChanges(
  snapshot: NativeSettingsSnapshot,
  draft: Readonly<Record<string, NativeSettingValue>>,
) {
  const edited = snapshot.fields.filter(
    (field) => Object.hasOwn(draft, field.id) && !equal(field.value, draft[field.id]),
  );
  const shortcutGroups = new Set(
    edited
      .filter((field) => field.id.startsWith("shortcuts."))
      .map((field) => field.id.split(".").slice(0, -1).join(".")),
  );
  return Object.fromEntries(
    snapshot.fields
      .filter(
        (field) =>
          edited.includes(field) || shortcutGroups.has(field.id.split(".").slice(0, -1).join(".")),
      )
      .map((field) => [field.id, { expected: field.value, value: draft[field.id] ?? field.value }]),
  );
}

function ValueControl({
  field,
  value,
  disabled,
  onChange,
}: {
  field: NativeSettingsField;
  value: NativeSettingValue;
  disabled: boolean;
  onChange: (value: NativeSettingValue) => void;
}) {
  const label = field.id.split(".").map(settingLabel).join(" · ");
  const options = field.options ?? localOptions[field.id];
  if (typeof value === "boolean")
    return (
      <Switch checked={value} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
    );
  if (Array.isArray(value)) {
    if (field.id.endsWith("order"))
      return (
        <div className={styles.ordered}>
          {value.map((item, index) => (
            <div key={item} className={styles.orderRow}>
              <span>{settingLabel(item)}</span>
              <span className={styles.actions}>
                {[-1, 1].map((direction) => (
                  <Button
                    key={direction}
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Move ${settingLabel(item)} ${direction < 0 ? "up" : "down"}`}
                    disabled={
                      disabled || index + direction < 0 || index + direction >= value.length
                    }
                    onClick={() => {
                      const next = [...value];
                      [next[index], next[index + direction]] = [
                        next[index + direction]!,
                        next[index]!,
                      ];
                      onChange(next);
                    }}
                  >
                    {direction < 0 ? <ArrowUpIcon size={12} /> : <ArrowDownIcon size={12} />}
                  </Button>
                ))}
              </span>
            </div>
          ))}
        </div>
      );
    if (options)
      return (
        <div className={styles.list}>
          {[...new Set([...options, ...value])].map((item) => (
            <label key={item} className={styles.choice}>
              <input
                type="checkbox"
                checked={value.includes(item)}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...value, item]
                      : value.filter((entry) => entry !== item),
                  )
                }
              />
              {settingLabel(item)}
            </label>
          ))}
        </div>
      );
    return (
      <input
        className={styles.field}
        aria-label={label}
        disabled={disabled}
        value={value.join(", ")}
        onChange={(event) =>
          onChange(
            event.target.value
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean),
          )
        }
      />
    );
  }
  if (options)
    return (
      <select
        className={styles.field}
        aria-label={label}
        disabled={disabled}
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
      >
        {[...new Set([...options, String(value)])].map((option) => (
          <option key={option} value={option}>
            {field.optionLabels?.[option] ?? settingLabel(option)}
          </option>
        ))}
      </select>
    );
  return (
    <input
      className={styles.field}
      aria-label={label}
      disabled={disabled}
      type={typeof value === "number" ? "number" : field.id.endsWith(".color") ? "color" : "text"}
      step="any"
      value={String(value)}
      onChange={(event) =>
        onChange(typeof value === "number" ? Number(event.target.value) : event.target.value)
      }
    />
  );
}

function NativeShortcuts({
  fields,
  draft,
  disabled,
  onChange,
}: {
  fields: readonly NativeSettingsField[];
  draft: Record<string, NativeSettingValue>;
  disabled: boolean;
  onChange: (id: string, value: NativeSettingValue) => void;
}) {
  const searchTarget = useSettingsSearchTargetId();
  const shortcutGroups = new Map<string, NativeSettingsField[]>();
  for (const field of fields) {
    const group = field.id.split(".").slice(0, -1).join(".");
    shortcutGroups.set(group, [...(shortcutGroups.get(group) ?? []), field]);
  }
  const buckets = new Map<string, [string, NativeSettingsField[]][]>();
  const ordinary: NativeSettingsField[] = [];
  for (const [group, entries] of shortcutGroups) {
    if (group === "shortcuts") {
      ordinary.push(...entries);
      continue;
    }
    const bucket = entries.some((field) => field.id.endsWith(".key"))
      ? group.split(".").slice(0, -1).join(".")
      : group;
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), [group, entries]]);
  }
  return (
    <>
      {ordinary.map((field) => (
        <SettingsRow
          key={field.id}
          id={`native-${field.id}`}
          title="Global capture shortcuts"
          description={descriptions[field.id]}
          control={
            <ValueControl
              field={field}
              value={draft[field.id] ?? field.value}
              disabled={disabled}
              onChange={(value) => onChange(field.id, value)}
            />
          }
        />
      ))}
      {[...buckets]
        .sort(([a], [b]) =>
          a === "shortcuts.global" ? -1 : b === "shortcuts.global" ? 1 : a.localeCompare(b),
        )
        .map(([bucket, entries]) => (
          <details
            key={bucket}
            className={styles.shortcutGroup}
            open={searchTarget?.startsWith(`native-${bucket}.`) ? true : undefined}
          >
            <summary>
              {nativeSettingsGroupLabel(bucket)}
              <span>
                {entries.reduce(
                  (count, [, values]) =>
                    count + (values.some((f) => f.id.endsWith(".key")) ? 1 : values.length),
                  0,
                )}
              </span>
            </summary>
            {entries.map(([group, values]) => {
              const key = values.find((field) => field.id.endsWith(".key"));
              if (!key)
                return values.map((field) => (
                  <SettingsRow
                    key={field.id}
                    id={`native-${field.id}`}
                    title={
                      field.id.endsWith(".disabled")
                        ? "Disabled shortcuts"
                        : settingLabel(field.id.split(".").at(-1)!)
                    }
                    control={
                      <ValueControl
                        field={field}
                        value={draft[field.id] ?? field.value}
                        disabled={disabled}
                        onChange={(value) => onChange(field.id, value)}
                      />
                    }
                  />
                ));
              const modifiers = values.find((field) => field.id.endsWith(".modifiers"));
              const enabled = values.find((field) => field.id.endsWith(".enabled"));
              const selected = modifiers ? (draft[modifiers.id] ?? modifiers.value) : [];
              return (
                <SettingsSearchTarget key={group} id={`native-${group}`}>
                  {values.map((field) => (
                    <SettingsSearchTarget key={field.id} id={`native-${field.id}`} />
                  ))}
                  <SettingsRow
                    title={settingLabel(group.split(".").at(-1)!)}
                    control={
                      <div className={styles.shortcutControls}>
                        <ValueControl
                          field={key}
                          value={draft[key.id] ?? key.value}
                          disabled={disabled}
                          onChange={(value) => onChange(key.id, value)}
                        />
                        {modifiers && Array.isArray(selected) ? (
                          <div className={styles.shortcutModifiers}>
                            {(["command", "control", "option", "shift"] as const).map(
                              (modifier) => (
                                <label
                                  key={modifier}
                                  className={styles.shortcutModifier}
                                >
                                  <input
                                    type="checkbox"
                                    disabled={disabled}
                                    checked={selected.includes(modifier)}
                                    aria-label={`${settingLabel(group.split(".").at(-1)!)} · ${settingLabel(modifier)}`}
                                    onChange={(event) =>
                                      onChange(
                                        modifiers.id,
                                        event.target.checked
                                          ? [...selected, modifier]
                                          : selected.filter((value) => value !== modifier),
                                      )
                                    }
                                  />
                                  <span aria-hidden="true">
                                    {settingLabel(modifier).split(" ")[0]}
                                  </span>
                                </label>
                              ),
                            )}
                          </div>
                        ) : null}
                        {enabled ? (
                          <ValueControl
                            field={enabled}
                            value={draft[enabled.id] ?? enabled.value}
                            disabled={disabled}
                            onChange={(value) => onChange(enabled.id, value)}
                          />
                        ) : null}
                      </div>
                    }
                  />
                </SettingsSearchTarget>
              );
            })}
          </details>
        ))}
    </>
  );
}

interface OCRModel {
  id: string;
  name: string;
  baseURL: string;
  modelIdentifier: string;
  prompt?: string;
  hasAPIKey?: boolean;
  createdAt?: number;
  updatedAt?: number;
}
function OCRModels({
  value,
  disabled,
  savedIDs,
  onChange,
  action,
}: {
  value: string;
  disabled: boolean;
  savedIDs: readonly string[];
  onChange: (value: string) => void;
  action: (
    action: NativeSettingsCommand["action"],
    payload?: Record<string, unknown>,
  ) => Promise<void>;
}) {
  let models: OCRModel[] = [];
  try {
    models = JSON.parse(value) as OCRModel[];
  } catch {
    /* Native validation preserves the stored value. */
  }
  const update = (items: OCRModel[]) => onChange(JSON.stringify(items));
  return (
    <div className={styles.models}>
      {models.map((model, index) => (
        <div key={model.id} className={styles.model}>
          {(["name", "baseURL", "modelIdentifier", "prompt"] as const).map((key) => (
            <label key={key}>
              {
                {
                  name: "Name",
                  baseURL: "Base URL",
                  modelIdentifier: "Model",
                  prompt: "Prompt (optional)",
                }[key]
              }
              <input
                className={styles.field}
                disabled={disabled}
                value={model[key] ?? ""}
                onChange={(event) =>
                  update(
                    models.map((item, i) =>
                      i === index ? { ...item, [key]: event.target.value } : item,
                    ),
                  )
                }
              />
            </label>
          ))}
          {savedIDs.includes(model.id) ? (
            <SecretInput
              label={`${model.name || "Model"} API key`}
              saved={model.hasAPIKey === true}
              disabled={disabled}
              onSave={(key) => action("ocr-key", { id: model.id, key })}
            />
          ) : (
            <p className={styles.note}>Save the model before adding its API key.</p>
          )}
          {savedIDs.includes(model.id) ? (
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => action("ocr-test", { id: model.id })}
            >
              Test connection
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="xs"
            disabled={disabled}
            onClick={() => update(models.filter((_, i) => i !== index))}
          >
            Remove model
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() =>
          update([...models, { id: randomUUID(), name: "", baseURL: "", modelIdentifier: "" }])
        }
      >
        Add recognition model
      </Button>
    </div>
  );
}
function SecretInput({
  label,
  saved,
  disabled,
  onSave,
}: {
  label: string;
  saved?: boolean;
  disabled: boolean;
  onSave: (key: string) => Promise<void>;
}) {
  const [key, setKey] = useState("");
  return (
    <div className={styles.actions}>
      <input
        className={styles.field}
        type="password"
        autoComplete="new-password"
        aria-label={label}
        placeholder={saved ? "Key saved — enter to replace" : label}
        value={key}
        disabled={disabled}
        onChange={(event) => setKey(event.target.value)}
      />
      <Button
        size="xs"
        variant="outline"
        disabled={disabled || !key}
        onClick={async () => {
          const entered = key;
          setKey("");
          await onSave(entered);
        }}
      >
        Save key
      </Button>
      {saved ? (
        <Button size="xs" variant="ghost" disabled={disabled} onClick={() => onSave("")}>
          Remove key
        </Button>
      ) : null}
    </div>
  );
}

export function NativeSettingsSection(props: {
  category: NativeSettingsCategory;
  title?: string;
  description?: string;
}) {
  if (!isNativeSettingsHost()) return null;
  if (!window.desktopBridge?.nativeSettings)
    return (
      <p role="status" className={styles.note}>
        Reopen the updated Cinderdeck app to configure {props.title ?? settingLabel(props.category)}{" "}
        here.
      </p>
    );
  return <NativeSettingsForm key={props.category} {...props} />;
}
function NativeSettingsForm({
  category,
  title,
  description,
}: {
  category: NativeSettingsCategory;
  title?: string;
  description?: string;
}) {
  const host = true;
  const [snapshot, setSnapshot] = useState<NativeSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<Record<string, NativeSettingValue>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const live = useRef(true);
  const busy = useRef(false);
  const changes = snapshot ? nativeSettingsChanges(snapshot, draft) : {};
  const changedCount =
    snapshot?.fields.filter(
      (field) => Object.hasOwn(draft, field.id) && !equal(field.value, draft[field.id]),
    ).length ?? 0;
  const dirty = Object.keys(changes).length > 0;
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    withResolver: true,
    enableBeforeUnload: dirty,
  });
  const request = useCallback(
    async (action: NativeSettingsCommand["action"], payload?: Record<string, unknown>) => {
      if (busy.current) return;
      busy.current = true;
      setPending(true);
      setError("");
      setNotice("");
      try {
        if (!window.desktopBridge?.nativeSettings)
          throw new Error(
            "The native settings connection is unavailable. Reopen the complete Cinderdeck app.",
          );
        const result = await window.desktopBridge.nativeSettings({
          category,
          action,
          ...(payload ? { payload } : {}),
        });
        if (!live.current) return;
        setSnapshot(result);
        setDraft(Object.fromEntries(result.fields.map((field) => [field.id, field.value])));
        if (action === "update") setNotice("Settings saved.");
        else if (typeof result.status.notice === "string") setNotice(result.status.notice);
      } catch (cause) {
        if (live.current)
          setError(cause instanceof Error ? cause.message : "Could not load settings.");
      } finally {
        busy.current = false;
        if (live.current) setPending(false);
      }
    },
    [category],
  );
  useEffect(() => {
    live.current = true;
    if (host) void request("read");
    return () => {
      live.current = false;
    };
  }, [host, request]);
  useEffect(() => {
    if (
      (snapshot?.status.signingIn !== true &&
        snapshot?.status.working !== true &&
        !["preparing", "recording", "transcribing"].includes(String(snapshot?.status.phase))) ||
      dirty
    )
      return;
    const timer = setInterval(() => void request("read"), 1500);
    return () => clearInterval(timer);
  }, [
    snapshot?.status.signingIn,
    snapshot?.status.phase,
    snapshot?.status.working,
    dirty,
    request,
  ]);
  useEffect(() => {
    const refresh = () => {
      if (!dirty && !busy.current) void request("read");
    };
    if (!host) return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [dirty, host, request]);
  if (!host) return null;
  const groups = new Map<string, NativeSettingsField[]>();
  for (const field of snapshot?.fields ?? []) {
    if (
      category === "menuBar" &&
      ["menu_bar.hidden_items", "menu_bar.item_order"].includes(field.id)
    )
      continue;
    const group = field.id.split(".").slice(0, -1).join(".");
    groups.set(group, [...(groups.get(group) ?? []), field]);
  }
  const disabled = pending || snapshot?.status.locked === true;
  const safeAction = (
    action: NativeSettingsCommand["action"],
    payload?: Record<string, unknown>,
  ) => {
    if (dirty) {
      setError("Save or discard your changes before this action.");
      return Promise.resolve();
    }
    return request(action, payload);
  };
  return (
    <SettingsSearchTarget
      id={`native-${category}`}
      className={styles.panel}
      aria-label={title ?? settingLabel(category)}
    >
      <header className={styles.header}>
        <div>
          <h2>{title ?? settingLabel(category)}</h2>
          <p>{description ?? "Settings for this Mac"}</p>
        </div>
        <span className={styles.badge}>This Mac</span>
      </header>
      {pending && !snapshot ? (
        <p role="status" className={styles.note}>
          Loading settings…
        </p>
      ) : null}
      {error ? (
        <div role="alert" className={`${styles.feedback} ${styles.error}`}>
          {error}
          <div className={styles.actions}>
            <Button size="xs" variant="ghost" disabled={pending} onClick={() => request("read")}>
              Reload saved values
            </Button>
          </div>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className={styles.note}>
          {notice}
        </p>
      ) : null}
      {blocker.status === "blocked" ? (
        <div role="alert" className={styles.feedback}>
          You have unsaved changes.
          <div className={styles.actions}>
            <Button size="xs" onClick={() => blocker.reset()}>
              Keep editing
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setDraft(
                  Object.fromEntries(snapshot!.fields.map((field) => [field.id, field.value])),
                );
                blocker.proceed();
              }}
            >
              Discard and continue
            </Button>
          </div>
        </div>
      ) : null}
      {snapshot?.status.locked === true ? (
        <CloudUnlock disabled={pending} action={safeAction} />
      ) : null}
      {category === "shortcuts" && snapshot ? (
        <NativeShortcuts
          fields={snapshot.fields}
          draft={draft}
          disabled={disabled}
          onChange={(id, value) => setDraft((state) => ({ ...state, [id]: value }))}
        />
      ) : (
        [...groups].map(([group, fields]) => (
          <SettingsSection key={group} title={nativeSettingsGroupLabel(group)}>
            {fields.map((field) =>
              field.id === "capture.ocr.custom_models" ? (
                <div key={field.id} className="p-4">
                  <p className="mb-3 text-sm font-medium">Custom recognition models</p>
                  <OCRModels
                    value={String(draft[field.id] ?? field.value)}
                    savedIDs={(() => {
                      try {
                        return (JSON.parse(String(field.value)) as OCRModel[]).map((m) => m.id);
                      } catch {
                        return [];
                      }
                    })()}
                    disabled={disabled}
                    onChange={(value) => setDraft((state) => ({ ...state, [field.id]: value }))}
                    action={safeAction}
                  />
                </div>
              ) : (
                <SettingsRow
                  key={field.id}
                  id={`native-${field.id}`}
                  title={settingLabel(field.id.split(".").at(-1)!)}
                  description={descriptions[field.id]}
                  control={
                    field.id === "general.export_location" ? (
                      <div className={styles.actions}>
                        <span
                          className="max-w-64 truncate text-xs text-muted-foreground"
                          aria-label={String(field.value)}
                        >
                          {String(field.value)}
                        </span>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={disabled || dirty}
                          onClick={() => request("choose-export-folder")}
                        >
                          Choose folder…
                        </Button>
                      </div>
                    ) : (
                      <ValueControl
                        field={field}
                        value={draft[field.id] ?? field.value}
                        disabled={disabled}
                        onChange={(value) => setDraft((state) => ({ ...state, [field.id]: value }))}
                      />
                    )
                  }
                />
              ),
            )}
          </SettingsSection>
        ))
      )}
      {category === "menuBar" && snapshot ? (
        <NativeMenuItems
          fields={snapshot.fields}
          draft={draft}
          disabled={disabled}
          onChange={(id, value) => setDraft((state) => ({ ...state, [id]: value }))}
        />
      ) : null}
      {category === "permissions" && snapshot ? (
        <SettingsSection title="System permissions">
          {Object.entries({
            screen: "Screen Recording",
            microphone: "Microphone",
            accessibility: "Accessibility",
            files: "Files & folders",
            speech: "Speech Recognition",
          }).map(([pane, label]) => (
            <SettingsRow
              key={pane}
              title={label}
              description={
                pane === "screen"
                  ? "Required for screenshots and screen recordings."
                  : pane === "accessibility"
                    ? "Used by global shortcuts and external app controls."
                    : undefined
              }
              control={
                <div className={styles.actions}>
                  {Object.hasOwn(snapshot.status, pane) ? (
                    <span className="text-xs text-muted-foreground">
                      {snapshot.status[pane] ? "Granted" : "Not granted"}
                    </span>
                  ) : null}
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending}
                    onClick={() => request("permission", { pane })}
                  >
                    Open System Settings
                  </Button>
                </div>
              }
            />
          ))}
        </SettingsSection>
      ) : null}
      {category === "github" && snapshot ? (
        <GitHubConnection snapshot={snapshot} pending={pending} action={safeAction} />
      ) : null}
      {category === "dictation" && snapshot ? (
        <SettingsSection title="Transcription API key">
          <div className="p-4">
            <SecretInput
              label="Dictation API key"
              saved={snapshot.status.hasKey === true}
              disabled={disabled || dirty}
              onSave={(key) => request("dictation-key", { key })}
            />
            <p className={styles.note}>Keys are stored in macOS Keychain.</p>
          </div>
        </SettingsSection>
      ) : null}
      {category === "cloud" && snapshot && !snapshot.status.locked ? (
        <>
          <CloudCredentials snapshot={snapshot} disabled={pending || dirty} action={safeAction} />
          <SettingsSection title="Credential protection">
            <div className="p-4">
              <CloudProtection
                label="New cloud protection password"
                saved={snapshot.status.protected === true}
                disabled={pending || dirty}
                onSave={(password) => safeAction("cloud-protection", { password })}
              />
              <p className={styles.note}>
                Use at least four characters. You’ll need this password to edit cloud credentials.
              </p>
            </div>
          </SettingsSection>
        </>
      ) : null}
      {category === "dictation" && snapshot ? (
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="outline"
            disabled={
              pending ||
              dirty ||
              ["preparing", "transcribing"].includes(String(snapshot.status.phase))
            }
            onClick={() =>
              request(snapshot.status.phase === "recording" ? "dictation-stop" : "dictation-test")
            }
          >
            {snapshot.status.phase === "recording" ? "Stop test" : "Test dictation"}
          </Button>
          {snapshot.status.transcript ? (
            <p className="text-sm select-text">{snapshot.status.transcript}</p>
          ) : snapshot.status.message ? (
            <p role="status" className={styles.note}>
              {snapshot.status.message}
            </p>
          ) : null}
        </div>
      ) : null}
      {category === "advanced" && snapshot ? (
        <SettingsSection title="Configuration backup">
          <SettingsRow
            title="Configuration file"
            description={String(snapshot.status.configPath)}
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={pending || dirty}
                onClick={() =>
                  request(snapshot.status.needsConfigAccess ? "config-grant" : "config-open")
                }
              >
                {snapshot.status.needsConfigAccess ? "Grant access…" : "Open file"}
              </Button>
            }
          />
          <div className="p-4">
            <div className={styles.actions}>
              {(["config-export", "config-import", "config-restore"] as const).map((action, i) => (
                <Button
                  key={action}
                  size="sm"
                  variant="outline"
                  disabled={pending || dirty || snapshot.status.needsConfigAccess === true}
                  onClick={() => request(action)}
                >
                  {["Export backup…", "Import backup…", "Restore native defaults…"][i]}
                </Button>
              ))}
            </div>
          </div>
        </SettingsSection>
      ) : null}
      {category === "menuBar" && snapshot ? (
        <SettingsSection title="Menu customization">
          <div className="p-4">
            <div className={styles.actions}>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || dirty}
                onClick={() => request("menu-icon-import")}
              >
                Import PNG icon…
              </Button>
              {snapshot.status.hasCustomIcon ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending || dirty}
                  onClick={() => request("menu-icon-remove")}
                >
                  Remove custom icon
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                disabled={pending || dirty}
                onClick={() => request("menu-reset")}
              >
                Reset menu
              </Button>
            </div>
          </div>
        </SettingsSection>
      ) : null}
      {category === "history" ? (
        <SettingsSection title="Local history storage">
          <div className="p-4">
            <div className={styles.actions}>
              {(["history-open", "clipboard-clear", "history-clear"] as const).map(
                (action, index) => (
                  <Button
                    key={action}
                    size="sm"
                    variant="outline"
                    disabled={pending || dirty}
                    onClick={() => request(action)}
                  >
                    {
                      ["Open capture storage", "Clear clipboard text…", "Clear capture history…"][
                        index
                      ]
                    }
                  </Button>
                ),
              )}
            </div>
          </div>
        </SettingsSection>
      ) : null}
      {category === "advanced" ? (
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || dirty || snapshot?.status.needsConfigAccess === true}
            onClick={() => request("config-sync")}
          >
            Sync configuration
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || dirty}
            onClick={() => request("logs-open")}
          >
            Open diagnostics folder
          </Button>
        </div>
      ) : null}
      {category === "shortcuts" ? (
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || dirty}
            onClick={() => request("shortcuts-reset")}
          >
            Reset desktop shortcuts
          </Button>
        </div>
      ) : null}
      {category === "permissions" ? (
        <SettingsSection title="Notifications">
          <SettingsRow
            title="Capture notifications"
            description="Allow Cinderdeck to show recognition results and capture notifications."
            control={
              <div className={styles.actions}>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pending}
                  onClick={() => request("notification-allow")}
                >
                  Allow notifications
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => request("notification-open")}
                >
                  Open System Settings
                </Button>
              </div>
            }
          />
        </SettingsSection>
      ) : null}
      {category === "cloud" && snapshot && !snapshot.status.locked ? (
        <CloudTransfer
          disabled={pending || dirty}
          configured={snapshot.status.configured === true}
          action={safeAction}
        />
      ) : null}
      {category === "updates" && snapshot ? (
        <SettingsSection title="Software update">
          <div className="space-y-3 p-4">
            <p role="status" className="text-sm">
              {snapshot.status.message}
            </p>
            {typeof snapshot.status.lastCheck === "string" ? (
              <p className={styles.note}>Last checked {snapshot.status.lastCheck}</p>
            ) : null}
            {typeof snapshot.status.progress === "string" ? (
              <progress
                className="w-full"
                aria-label="Update progress"
                value={Number(snapshot.status.progress)}
                max={1}
              />
            ) : null}
            {typeof snapshot.status.releaseNotes === "string" &&
            snapshot.status.releaseNotes.startsWith("https://") ? (
              <a
                className="text-xs underline"
                href={snapshot.status.releaseNotes}
                target="_blank"
                rel="noreferrer"
              >
                Release notes
              </a>
            ) : null}
            <div className={styles.actions}>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  pending ||
                  dirty ||
                  snapshot.status.working === true ||
                  (snapshot.status.phase !== "unavailable" && snapshot.status.canCheck !== true)
                }
                onClick={() => request("check-updates")}
              >
                {snapshot.status.phase === "unavailable" ? "View releases" : "Check for updates"}
              </Button>
              {snapshot.status.canInstall === true ? (
                <Button
                  size="sm"
                  disabled={pending || dirty}
                  onClick={() => request("install-update")}
                >
                  {snapshot.status.informationOnly
                    ? "View update"
                    : snapshot.status.phase === "ready"
                      ? "Restart to update"
                      : "Download & install"}
                </Button>
              ) : null}
            </div>
          </div>
        </SettingsSection>
      ) : null}
      {category === "about" && snapshot ? (
        <SettingsSection title="Cinderdeck">
          <SettingsRow
            title="Version"
            control={
              <span className="text-sm">
                {snapshot.status.version} ({snapshot.status.build})
              </span>
            }
          />
          <SettingsRow
            title="Open source licenses"
            control={
              <Link to="/settings/open-source-licenses" className="text-sm underline">
                View acknowledgments
              </Link>
            }
          />
          <SettingsRow
            title="Support"
            control={
              <a
                href="https://github.com/RyanCardin15/Cinderdeck/issues"
                target="_blank"
                rel="noreferrer"
                className="text-sm underline"
              >
                Report an issue
              </a>
            }
          />
        </SettingsSection>
      ) : null}
      {dirty ? (
        <div className={styles.saveBar}>
          <span>
            {changedCount} unsaved {changedCount === 1 ? "change" : "changes"}
          </span>
          <div className={styles.actions}>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => {
                setDraft(
                  Object.fromEntries(snapshot!.fields.map((field) => [field.id, field.value])),
                );
                setError("");
              }}
            >
              Discard
            </Button>
            <Button size="sm" disabled={disabled} onClick={() => request("update", { changes })}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </div>
      ) : null}
    </SettingsSearchTarget>
  );
}
function GitHubConnection({
  snapshot,
  pending,
  action,
}: {
  snapshot: NativeSettingsSnapshot;
  pending: boolean;
  action: (
    action: NativeSettingsCommand["action"],
    payload?: Record<string, unknown>,
  ) => Promise<void>;
}) {
  const [host, setHost] = useState(String(snapshot.status.host ?? "github.com"));
  const status = snapshot.status;
  return (
    <SettingsSection title="GitHub account">
      <SettingsRow
        title="Account"
        description={String(
          status.message ||
            status.notice ||
            "Use one connection for repositories and pull requests.",
        )}
        control={
          <span className="text-sm">{status.login ? `@${status.login}` : "Not connected"}</span>
        }
      />
      <SettingsRow
        title="GitHub host"
        control={
          <div className={styles.actions}>
            <input
              className={styles.field}
              aria-label="GitHub host"
              value={host}
              disabled={pending || status.signingIn === true}
              onChange={(event) => setHost(event.target.value)}
            />
            <Button
              size="xs"
              variant="outline"
              disabled={pending || status.signingIn === true || host === status.host}
              onClick={() => action("github-host", { host })}
            >
              Use host
            </Button>
          </div>
        }
      />
      <div className="p-4 space-y-3">
        {status.error ? (
          <p role="alert" className={styles.error}>
            {status.error}
          </p>
        ) : null}
        {status.code ? (
          <p className="text-sm">
            Authorization code: <strong className="font-mono select-all">{status.code}</strong>
          </p>
        ) : null}
        {typeof status.url === "string" && status.url.startsWith("https://") ? (
          <a className="text-sm underline" href={status.url} target="_blank" rel="noreferrer">
            Continue GitHub authorization
          </a>
        ) : null}
        <div className={styles.actions}>
          <Button
            size="sm"
            disabled={pending || status.checking === true || status.managedByEnvironment === true}
            onClick={() => action(status.signingIn === true ? "github-cancel" : "github-sign-in")}
          >
            {status.signingIn === true
              ? "Cancel sign-in"
              : status.login
                ? "Switch account"
                : "Connect GitHub"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || status.signingIn === true}
            onClick={() => action("github-refresh")}
          >
            <RefreshCwIcon size={13} />
            Refresh
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}
function CloudUnlock({
  disabled,
  action,
}: {
  disabled: boolean;
  action: (
    action: NativeSettingsCommand["action"],
    payload?: Record<string, unknown>,
  ) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  return (
    <div className={styles.feedback}>
      Cloud settings are protected.
      <div className={styles.actions}>
        <input
          className={styles.field}
          type="password"
          aria-label="Cloud protection password"
          autoComplete="current-password"
          disabled={disabled}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Button
          size="sm"
          disabled={disabled || !password}
          onClick={() => {
            const entered = password;
            setPassword("");
            void action("cloud-unlock", { password: entered });
          }}
        >
          Unlock
        </Button>
      </div>
    </div>
  );
}
function CloudCredentials({
  snapshot,
  disabled,
  action,
}: {
  snapshot: NativeSettingsSnapshot;
  disabled: boolean;
  action: (
    action: NativeSettingsCommand["action"],
    payload?: Record<string, unknown>,
  ) => Promise<void>;
}) {
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const google =
    snapshot.fields.find((field) => field.id === "cloud.provider")?.value === "google_drive";
  return (
    <SettingsSection title="Credentials">
      <div className="p-4 space-y-3">
        <p className={styles.note}>
          {snapshot.status.configured
            ? "Storage is connected. Enter credentials to replace them."
            : "Save your storage configuration, then connect it."}{" "}
          Credentials are stored in macOS Keychain.
        </p>
        <input
          className={styles.field}
          type="password"
          autoComplete="new-password"
          aria-label={google ? "Google client ID" : "Access key"}
          placeholder={google ? "Google client ID" : "Access key"}
          disabled={disabled}
          value={accessKey}
          onChange={(event) => setAccessKey(event.target.value)}
        />
        <input
          className={styles.field}
          type="password"
          autoComplete="new-password"
          aria-label={google ? "Google client secret" : "Secret key"}
          placeholder={google ? "Google client secret" : "Secret key"}
          disabled={disabled}
          value={secretKey}
          onChange={(event) => setSecretKey(event.target.value)}
        />
        <div className={styles.actions}>
          <Button
            size="sm"
            disabled={disabled || !accessKey || !secretKey}
            onClick={() => {
              const payload = { accessKey, secretKey };
              setAccessKey("");
              setSecretKey("");
              void action("cloud-save", payload);
            }}
          >
            {google ? "Authorize Google Drive" : "Connect storage"}
          </Button>
          {snapshot.status.configured ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => action("cloud-clear")}
            >
              Disconnect storage
            </Button>
          ) : null}
        </div>
      </div>
    </SettingsSection>
  );
}
export function NativeSettingsPage({ path }: { path: NativeSettingsPath }) {
  const page = NATIVE_SETTINGS_PAGES[path];
  return (
    <SettingsPageContainer>
      {isNativeSettingsHost() ? (
        <NativeSettingsSection
          key={page.category}
          category={page.category}
          title={page.title}
          description={page.description}
        />
      ) : (
        <>
          <h1 className="text-lg font-semibold">{page.title}</h1>
          <p className={styles.note}>
            These settings are available in the complete Cinderdeck Mac app.
          </p>
        </>
      )}
    </SettingsPageContainer>
  );
}

function CloudTransfer({
  disabled,
  configured,
  action,
}: {
  disabled: boolean;
  configured: boolean;
  action: (
    action: NativeSettingsCommand["action"],
    payload?: Record<string, unknown>,
  ) => Promise<void>;
}) {
  const [passphrase, setPassphrase] = useState("");
  const run = (operation: "cloud-export" | "cloud-import") => {
    const entered = passphrase;
    setPassphrase("");
    void action(operation, { passphrase: entered });
  };
  return (
    <SettingsSection title="Encrypted credential transfer">
      <div className="space-y-3 p-4">
        <p className={styles.note}>
          Move your storage connection using an encrypted archive. Use the same archive passphrase
          on both Macs, with at least 12 characters.
        </p>
        <input
          className={styles.field}
          type="password"
          aria-label="Archive passphrase"
          autoComplete="new-password"
          disabled={disabled}
          value={passphrase}
          onChange={(event) => setPassphrase(event.target.value)}
        />
        <div className={styles.actions}>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || passphrase.length < 12}
            onClick={() => run("cloud-import")}
          >
            Import archive…
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || !configured || passphrase.length < 12}
            onClick={() => run("cloud-export")}
          >
            Export archive…
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}

function CloudProtection({
  label,
  saved,
  disabled,
  onSave,
}: {
  label: string;
  saved: boolean;
  disabled: boolean;
  onSave: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  return (
    <div className="space-y-3">
      <div className={styles.actions}>
        <input
          className={styles.field}
          type="password"
          autoComplete="new-password"
          aria-label={label}
          placeholder={saved ? "Enter a replacement password" : label}
          disabled={disabled}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <input
          className={styles.field}
          type="password"
          autoComplete="new-password"
          aria-label="Confirm cloud protection password"
          placeholder="Confirm password"
          disabled={disabled}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </div>
      <div className={styles.actions}>
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || password.length < 4 || password !== confirmation}
          onClick={() => {
            const entered = password;
            setPassword("");
            setConfirmation("");
            void onSave(entered);
          }}
        >
          Save password
        </Button>
        {saved ? (
          <Button size="xs" variant="ghost" disabled={disabled} onClick={() => onSave("")}>
            Remove password
          </Button>
        ) : null}
      </div>
    </div>
  );
}
