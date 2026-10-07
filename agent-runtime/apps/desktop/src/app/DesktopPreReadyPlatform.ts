import * as ElectronProtocol from "../electron/ElectronProtocol.ts";

// Keep Electron's strict pre-ready setup isolated so later runtime layers cannot
// observe app readiness before scheme privileges exist.
export const layer = ElectronProtocol.layerSchemePrivileges;
