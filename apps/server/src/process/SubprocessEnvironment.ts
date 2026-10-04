/** Keep the native shell's UI credential out of unprivileged child processes. */
export function subprocessEnvironment(environment: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const name of Object.keys(result)) {
    if (name.toUpperCase() === "CINDERDECK_NATIVE_UI_TOKEN") delete result[name];
  }
  return result;
}
