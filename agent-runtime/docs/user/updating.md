# Updating Cinderdeck

Use Cinderdeck’s native update action to update the complete macOS app. The bundled runtime is updated with the host; it has no independent feed or installer. Source builds use [the complete app builder](../../../docs/UNIFIED_APP.md).

Before restarting, stop or finish active agents, services, and terminal commands. Conversations and provider resume state remain in the host’s AgentRuntime directory. A companion and its execution host must use compatible wire contracts; update the machine named in a version mismatch and reconnect.

Provider updates are separate: **Settings → Providers** shows installed provider versions and available actions. Credentials stay with the provider CLI on the execution computer.

The mobile companion is built from `apps/mobile`. This repository does not configure the original vendor’s store listing or over-the-air update project. Configure a Cinderdeck distribution project before publishing companion builds.
