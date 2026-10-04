import { contextBridge, ipcRenderer } from "electron";
// Installed only in the isolated, app-owned encoder window. No app page or guest
// receives this bridge; Main additionally verifies the exact sender and frame.
contextBridge.exposeInMainWorld("deckhandOwnedEncoder", {
  onFrame: (listener: (data: string) => void) => {
    ipcRenderer.on("deckhand:owned-encoder:frame", (_event, data: unknown) => {
      if (typeof data === "string") listener(data);
    });
  },
  onStop: (listener: () => void) => ipcRenderer.on("deckhand:owned-encoder:stop", () => listener()),
  report: (message: unknown) => ipcRenderer.invoke("deckhand:owned-encoder:result", message),
});
