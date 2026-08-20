const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kakeboAudit", {
  listHistory: () => ipcRenderer.invoke("audit:list"),
  setHistoryLimit: (limit) => ipcRenderer.invoke("audit:limit:set", limit),
  close: () => ipcRenderer.invoke("audit:close"),
  onHistoryChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("audit:history-changed", handler);
    return () => ipcRenderer.removeListener("audit:history-changed", handler);
  }
});
