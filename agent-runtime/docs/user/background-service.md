# Running Cinderdeck in the background

The installed macOS Cinderdeck app owns its agent backend and workspace services. Keep the host running to use the mobile companion. Quit through Cinderdeck so its running-work confirmation and child shutdown can complete.

For development, use an isolated server/web session from [the development guide](../operations/development.md). The runtime’s service modules support compatible execution hosts; they are not a separately distributed CLI product. Do not install an old standalone agent release to run Cinderdeck.
