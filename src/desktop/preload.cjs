const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kakebo", {
  bootstrap: () => ipcRenderer.invoke("app:bootstrap"),
  startSync: (request) => ipcRenderer.invoke("sync:start", request),
  resolveAccountFailure: (input) =>
    ipcRenderer.invoke("sync:account-failure:resolve", input),
  saveAccounts: (accounts) => ipcRenderer.invoke("accounts:save", accounts),
  saveRules: (configuration) => ipcRenderer.invoke("rules:save", configuration),
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
  listBanks: (country) => ipcRenderer.invoke("banks:list", { country }),
  connectBank: (request) => ipcRenderer.invoke("connection:connect", request),
  reauthorize: (connectionId) =>
    ipcRenderer.invoke("connection:reauthorize", connectionId),
  disconnectBank: (connectionId) =>
    ipcRenderer.invoke("connection:disconnect", connectionId),
  runDoctor: () => ipcRenderer.invoke("doctor:run"),
  openAuditHistory: () => ipcRenderer.invoke("audit:open"),
  clearAuditHistory: () => ipcRenderer.invoke("audit:clear"),
  clearExportFiles: () => ipcRenderer.invoke("exports:clear"),
  openPath: (target) => ipcRenderer.invoke("path:open", target),
  copyText: (value) => ipcRenderer.invoke("clipboard:write", value),
  setupLocalHttps: () => ipcRenderer.invoke("https:setup"),
  confirmClose: () => ipcRenderer.invoke("app:confirm-close"),
  onCloseRequested: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("app:close-requested", handler);
    return () => ipcRenderer.removeListener("app:close-requested", handler);
  },
  onSyncProgress: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("sync:progress", handler);
    return () => ipcRenderer.removeListener("sync:progress", handler);
  },
  onAccountFailure: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("sync:account-failure", handler);
    return () => ipcRenderer.removeListener("sync:account-failure", handler);
  },
  onAuthorizationResult: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("authorization:result", handler);
    return () => ipcRenderer.removeListener("authorization:result", handler);
  }
});
