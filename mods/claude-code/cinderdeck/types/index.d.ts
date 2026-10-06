export type CinderdeckService = {
  name: string
  status: string
  ready: boolean
  port: number | null
  url: string | null
  detail: string | null
}

export type CinderdeckWorkspace = {
  id: string
  name: string
  state: string
  services: CinderdeckService[]
}

declare module 'claude-code' {
  interface PluginState {
    cinderdeck: {
      workspace: CinderdeckWorkspace | null
      problem: string | null
      logs: { service: string; lines: string[] } | null
    }
  }
}
