import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("musicControl", {
  status: () => ipcRenderer.invoke("desktop:status"), chooseFolder: () => ipcRenderer.invoke("desktop:choose-folder"),
  enroll: (password: string, label: string, serverUrl: string) => ipcRenderer.invoke("desktop:enroll", password, label, serverUrl),
  request: (endpoint: string, init?: RequestInit) => ipcRenderer.invoke("desktop:request", endpoint, init),
  download: (track: { trackId: number; fileName: string; contentHash: string }) => ipcRenderer.invoke("desktop:download", track),
  cacheInventory: () => ipcRenderer.invoke("desktop:cache-inventory"),
  localMedia: () => ipcRenderer.invoke("desktop:local-media"),
  localAssignments: () => ipcRenderer.invoke("desktop:local-assignments"),
  saveLocalAssignments: (value: unknown) => ipcRenderer.invoke("desktop:save-local-assignments", value),
  rescan: () => ipcRenderer.invoke("desktop:rescan")
});
