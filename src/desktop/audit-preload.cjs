const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kakeboAudit", {
  listHistory: () => ipcRenderer.invoke("audit:list"),
  close: () => ipcRenderer.invoke("audit:close")
});
