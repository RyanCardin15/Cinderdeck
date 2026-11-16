import * as C from "@cinderdeck/contracts/deckhand/computerUse";
import { OrchestratorMcpFailure } from "@cinderdeck/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Service from "../../../deckhand/ComputerUse.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import {
  ComputerUseToolkit,
  ComputerUseStandardToolkit,
  ComputerUseStateToolkit,
  ComputerUseScriptToolkit,
} from "./tools.ts";

const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const isComputerUseError = Schema.is(C.ComputerUseError);
const toFailure = (cause: unknown) =>
  isMcpFailure(cause)
    ? cause
    : new OrchestratorMcpFailure({
        code: "invalid_request",
        message: isComputerUseError(cause)
          ? `${cause.reason}: ${cause.message}`
          : "The computer-use request could not be completed.",
      });

const actor = Effect.gen(function* () {
  const { scope, caller } = yield* readCaller();
  const thread = yield* Invocation.requireThreadScope(scope, "Computer use");
  return {
    threadId: thread.thread.threadId,
    label: (caller?.title.trim() || "Agent").slice(0, 40),
  };
});

const act =
  <K extends Service.ComputerAction["kind"]>(kind: K) =>
  (input: Extract<Service.ComputerAction, { kind: K }>["input"]) =>
    Effect.gen(function* () {
      const who = yield* actor;
      return yield* (yield* Service.ComputerUse).act(who, {
        kind,
        input,
      } as Service.ComputerAction);
    }).pipe(Effect.mapError(toFailure));

const rawHandlers = {
  computer_list_apps: Effect.fn("ComputerUse.listApps")(function* () {
    const who = yield* actor;
    return yield* (yield* Service.ComputerUse).listApps(who);
  }, Effect.mapError(toFailure)),
  computer_get_app_state: Effect.fn("ComputerUse.getAppState")(function* (
    input: C.ComputerGetAppState,
  ) {
    const who = yield* actor;
    return yield* (yield* Service.ComputerUse).getAppState(who, input);
  }, Effect.mapError(toFailure)),
  computer_click: act("click"),
  computer_type_text: act("type_text"),
  computer_press_key: act("press_key"),
  computer_scroll: act("scroll"),
  computer_set_value: act("set_value"),
  computer_select_text: act("select_text"),
  computer_perform_secondary_action: act("perform_secondary_action"),
  computer_drag: act("drag"),
  computer_paste: act("paste"),
  computer_activate_app: act("activate_app"),
  computer_script: Effect.fn("ComputerUse.script")(function* (input: C.ComputerScript) {
    const who = yield* actor;
    return yield* (yield* Service.ComputerUse).script(who, input);
  }, Effect.mapError(toFailure)),
};

const handlers = {
  computer_list_apps: McpToolAccess.readsAsCaller(rawHandlers.computer_list_apps),
  computer_get_app_state: McpToolAccess.actsAsCaller(rawHandlers.computer_get_app_state),
  computer_click: McpToolAccess.actsAsCaller(rawHandlers.computer_click),
  computer_type_text: McpToolAccess.actsAsCaller(rawHandlers.computer_type_text),
  computer_press_key: McpToolAccess.actsAsCaller(rawHandlers.computer_press_key),
  computer_scroll: McpToolAccess.actsAsCaller(rawHandlers.computer_scroll),
  computer_set_value: McpToolAccess.actsAsCaller(rawHandlers.computer_set_value),
  computer_select_text: McpToolAccess.actsAsCaller(rawHandlers.computer_select_text),
  computer_perform_secondary_action: McpToolAccess.actsAsCaller(
    rawHandlers.computer_perform_secondary_action,
  ),
  computer_drag: McpToolAccess.actsAsCaller(rawHandlers.computer_drag),
  computer_paste: McpToolAccess.actsAsCaller(rawHandlers.computer_paste),
  computer_activate_app: McpToolAccess.actsAsCaller(rawHandlers.computer_activate_app),
  computer_script: McpToolAccess.actsAsCaller(rawHandlers.computer_script),
} satisfies McpToolAccess.Handlers<typeof ComputerUseToolkit.tools>;
const { computer_get_app_state, computer_script, ...standard } = handlers;
export const layerStandard = McpToolAccess.toLayer(ComputerUseStandardToolkit, standard);
export const layerState = McpToolAccess.toLayer(ComputerUseStateToolkit, {
  computer_get_app_state,
});
export const layerScript = McpToolAccess.toLayer(ComputerUseScriptToolkit, { computer_script });
