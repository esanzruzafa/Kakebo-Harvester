const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kakeboAudit", {
  listHistory: () => ipcRenderer.invoke("audit:list"),
  setHistoryLimit: (limit) => ipcRenderer.invoke("audit:limit:set", limit),
  close: () => ipcRenderer.invoke("audit:close")
});
