import Foundation

/// Text shown to coding agents: MCP server instructions, `cinderdeck stacks agent-help`,
/// and the block written into AGENTS.md / CLAUDE.md by `setup-agents`.
nonisolated enum StackAgentGuide {
  static let mcpInstructions = """
  Cinderdeck Stacks runs the user's local dev services (APIs, frontends, emulators) as named stacks. \
  Prefer these tools over starting long-running dev servers in your own terminal: services started here keep running, \
  show up in the user's Cinderdeck panel, and are attributed to you. \
  Typical flow: list_stacks → claim_stack (while you depend on it) → start_stack (waits until ready and returns \
  crash output if something fails) → read_logs when debugging → release_stack when done. \
  Before starting your own server, call list_ports to see who already owns the port (another agent's terminal, \
  a Cinderdeck service, or the user). Never stop a stack claimed by someone else without asking the user. \
  switch_branch refuses to touch uncommitted work unless you pass dirty=stash or dirty=carry.
  """

  static let template = """
  # ~/.config/cinderdeck/stacks/<id>.toml  (id: letters, numbers, - and _)
  name = "My project"
  root = "~/Src"                  # base for relative paths

  [repos.api]                     # optional: Git working trees shown with branches
  path = "my-api"

  [services.db]
  cmd = "docker compose up db"    # stay in the foreground (no -d)
  port = 5432
  ready.port = 5432

  [services.api]
  repo = "api"                    # cwd defaults to the repo path
  cmd = "npm run dev"
  depends_on = ["db"]
  port = 4000
  ready.http = "http://localhost:4000/health"   # or ready.log = "listening"
  env.DATABASE_URL = "postgres://localhost:5432/app"
  """

  static func instructions(command: String) -> String {
    """
    ## Local dev services (Cinderdeck Stacks)

    This machine runs dev services through Cinderdeck Stacks. Use it instead of starting \
    long-running servers in your own terminal, so services are shared, visible to the user, and attributed to you.

    - MCP: the `cinderdeck` server (tools `list_stacks`, `start_stack`, `read_logs`, `list_ports`, `switch_branch`, …).
    - CLI: `\(command) stacks <command> [--json]`
      - `status` — every stack, service state, ports, owners and branches
      - `start <stack> [service…]` — starts in dependency order and waits until ready (`--no-wait` to return early)
      - `restart <stack> [service]`, `stop <stack> [service…]`
      - `logs <stack> [service] -n 200 [--grep regex] [-f]`
      - `ports` — who owns each listening port (Cinderdeck service, or which app/terminal started it)
      - `claim <stack> --note "running e2e" --ttl 30` / `release <stack>` while you depend on a stack
      - `switch <stack> <branch> [--repo id] [--stash|--carry]`, `git <stack>`, `branches <stack>`
    - Live state without any call: `\(StackControlPaths.state.path)`; log files: `~/Library/Logs/Cinderdeck/Stacks/<stack>/<service>.log`
    - Stack definitions are TOML files in `~/.config/cinderdeck/stacks/`. Validate with `\(command) stacks validate <file>`.
    - Respect claims held by other agents. Do not kill processes you did not start without asking the user.
    """
  }
}
