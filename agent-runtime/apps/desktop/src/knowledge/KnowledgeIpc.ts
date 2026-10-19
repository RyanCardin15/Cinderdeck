import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Electron from "electron";
import { LOCAL_KNOWLEDGE_CHANNEL, type SkillImportAgent } from "@cinderdeck/contracts";
import { LocalKnowledge } from "./LocalKnowledge.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";

class KnowledgeError extends Schema.TaggedError<KnowledgeError>()("KnowledgeError", {
  message: Schema.String,
}) {}

const attempt = <T>(operation: () => Promise<T>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new KnowledgeError({
        message: cause instanceof Error ? cause.message : "The knowledge request failed.",
      }),
  });

export const installKnowledgeIpc = Effect.fn("desktop.knowledge.install")(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const windows = yield* ElectronWindow.ElectronWindow;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const ipc = yield* DesktopIpc.DesktopIpc;
  const store = new LocalKnowledge(environment.stateDir, environment.homeDirectory);
  yield* ipc.handle({
    channel: LOCAL_KNOWLEDGE_CHANNEL,
    handler: (raw, event) =>
      Effect.gen(function* () {
        const owner = yield* windows.currentMainOrFirst;
        if (
          Option.isNone(owner) ||
          owner.value.webContents.id !== event?.sender.id ||
          (event as Electron.IpcMainInvokeEvent | undefined)?.senderFrame !==
            owner.value.webContents.mainFrame
        )
          throw new Error(
            "Knowledge connections are only available to the main Cinderdeck window.",
          );
        if (
          !raw ||
          typeof raw !== "object" ||
          Array.isArray(raw) ||
          Object.keys(raw).length > 5 ||
          Object.values(raw).some(
            (value) =>
              value !== null &&
              value !== undefined &&
              (typeof value !== "string" || value.length > 4096),
          )
        )
          throw new Error("Invalid knowledge request.");
        const input = raw as Record<string, unknown>;
        const string = (key: string) => {
          if (typeof input[key] !== "string") throw new Error(`Invalid ${key}.`);
          return input[key] as string;
        };
        const scope = () => {
          if (input.workspacePath === undefined || input.workspacePath === null)
            return input.workspacePath;
          return string("workspacePath");
        };
        const note = () => ({
          vaultID: string("vaultID"),
          path: string("path"),
          workspacePath: scope(),
        });
        const pick = () => dialog.pickFolder({ owner, defaultPath: Option.none() });
        switch (input.action) {
          case "list-vaults":
            return yield* attempt(() => store.listVaults(scope()));
          case "connect-vault": {
            const folder = yield* pick();
            return Option.isNone(folder)
              ? null
              : yield* attempt(() =>
                  store.connectVault(folder.value, string("name"), scope() ?? null),
                );
          }
          case "disconnect-vault":
            return yield* attempt(() => store.disconnectVault(string("id")));
          case "search-notes":
            return yield* attempt(() =>
              store.searchNotes({
                vaultID: string("vaultID"),
                query: string("query"),
                workspacePath: scope(),
              }),
            );
          case "read-note":
            return yield* attempt(() => store.readNote(note()));
          case "open-note": {
            const uri = yield* attempt(() => store.noteURI(note()));
            return yield* attempt(() => Electron.shell.openExternal(uri));
          }
          case "preview-skill": {
            const folder = yield* pick();
            return Option.isNone(folder)
              ? null
              : yield* attempt(() => store.previewSkill(folder.value));
          }
          case "import-skill":
            return yield* attempt(() =>
              store.importSkill({
                token: string("token"),
                agent: string("agent") as SkillImportAgent,
                workspacePath: scope() ?? null,
              }),
            );
          case "list-skills":
            return yield* attempt(() => store.listImportedSkills());
          case "forget-skill":
            return yield* attempt(() => store.removeImportedSkill(string("id")));
          default:
            throw new Error("Unsupported knowledge request.");
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.fail(
            new KnowledgeError({
              message: Cause.pretty(cause).split("\n")[0] || "Knowledge request failed.",
            }),
          ),
        ),
      ),
  });
});
