const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kakebo", {
  bootstrap: () => ipcRenderer.invoke("app:bootstrap"),
  startSync: (request) => ipcRenderer.invoke("sync:start", request),
  saveAccounts: (accounts) => ipcRenderer.invoke("accounts:save", accounts),
  saveRules: (rules) => ipcRenderer.invoke("rules:save", rules),
  saveCategories: (categories) =>
    ipcRenderer.invoke("categories:save", categories),
  saveExportSettings: (settings) =>
    ipcRenderer.invoke("export-settings:save", settings),
  saveCardImportProfiles: (profiles) =>
    ipcRenderer.invoke("cards:profiles:save", profiles),
  selectCardFiles: () => ipcRenderer.invoke("cards:files:select"),
  importCardFiles: (request) => ipcRenderer.invoke("cards:import", request),
  setLanguage: (language) => ipcRenderer.invoke("language:set", language),
  setAuditHistoryLimit: (limit) =>
    ipcRenderer.invoke("audit:limit:set", limit),
  reapplyRules: () => ipcRenderer.invoke("rules:reapply"),
  reauthorize: (connectionId) =>
    ipcRenderer.invoke("connection:reauthorize", connectionId),
  runDoctor: () => ipcRenderer.invoke("doctor:run"),
  openAuditHistory: () => ipcRenderer.invoke("audit:open"),
  clearAuditHistory: () => ipcRenderer.invoke("audit:clear"),
  clearExportFiles: () => ipcRenderer.invoke("exports:clear"),
  openPath: (target) => ipcRenderer.invoke("path:open", target),
  copyText: (value) => ipcRenderer.invoke("clipboard:write", value),
  setupLocalHttps: () => ipcRenderer.invoke("https:setup"),
  onSyncProgress: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("sync:progress", handler);
    return () => ipcRenderer.removeListener("sync:progress", handler);
  },
  onAuthorizationResult: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("authorization:result", handler);
    return () => ipcRenderer.removeListener("authorization:result", handler);
  }
});
