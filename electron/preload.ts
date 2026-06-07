import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pdfReader", {
  openPdfDialog: () => ipcRenderer.invoke("dialog:open-pdf"),
  savePdfDialog: (defaultPath?: string) => ipcRenderer.invoke("dialog:save-pdf", defaultPath),
  saveMarkdownDialog: (defaultPath?: string) => ipcRenderer.invoke("dialog:save-markdown", defaultPath),
  confirmUnsaved: (documentName?: string) => ipcRenderer.invoke("dialog:confirm-unsaved", documentName),
  readPdf: (filePath: string) => ipcRenderer.invoke("file:read-pdf", filePath),
  readImage: (filePath: string) => ipcRenderer.invoke("file:read-image", filePath),
  readMarkdown: (filePath: string) => ipcRenderer.invoke("file:read-markdown", filePath),
  writePdf: (filePath: string, bytes: number[]) => ipcRenderer.invoke("file:write-pdf", filePath, bytes),
  writeMarkdown: (filePath: string, markdown: string) => ipcRenderer.invoke("file:write-markdown", filePath, markdown),
  openFileInNewWindow: (filePath: string) => ipcRenderer.invoke("window:new-for-file", filePath),
  setFullScreen: (enabled: boolean) => ipcRenderer.invoke("window:set-full-screen", enabled),
  isFullScreen: () => ipcRenderer.invoke("window:is-full-screen"),
  closeWindowAfterConfirm: () => ipcRenderer.invoke("window:close-after-confirm"),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke("shell:show-item", filePath),
  listRecentFiles: () => ipcRenderer.invoke("recent:list"),
  removeRecentFile: (filePath: string) => ipcRenderer.invoke("recent:remove", filePath),
  clearRecentFiles: () => ipcRenderer.invoke("recent:clear"),
  ai: {
    listProviders: () => ipcRenderer.invoke("ai:list-providers"),
    saveProvider: (provider: unknown) => ipcRenderer.invoke("ai:save-provider", provider),
    deleteProvider: (id: string) => ipcRenderer.invoke("ai:delete-provider", id),
    validateProvider: (id: string) => ipcRenderer.invoke("ai:validate-provider", id),
    fetchProviderModels: (id: string) => ipcRenderer.invoke("ai:fetch-provider-models", id),
    listLocalAgents: () => ipcRenderer.invoke("ai:list-local-agents"),
    refreshLocalAgents: () => ipcRenderer.invoke("ai:refresh-local-agents"),
    setLocalAgentEnabled: (id: string, enabled: boolean) => ipcRenderer.invoke("ai:set-local-agent-enabled", id, enabled)
  },
  semantic: {
    getSettings: () => ipcRenderer.invoke("semantic:get-settings"),
    saveSettings: (settings: unknown) => ipcRenderer.invoke("semantic:save-settings", settings),
    markModelDownloaded: (modelId: string) => ipcRenderer.invoke("semantic:mark-model-downloaded", modelId),
    removeModel: (modelId: string) => ipcRenderer.invoke("semantic:remove-model", modelId),
    loadDatabase: () => ipcRenderer.invoke("semantic:load-db"),
    saveDatabase: (bytes: number[]) => ipcRenderer.invoke("semantic:save-db", bytes),
    clearDatabase: () => ipcRenderer.invoke("semantic:clear-db"),
    databaseInfo: () => ipcRenderer.invoke("semantic:db-info")
  },
  markdown: {
    getSettings: () => ipcRenderer.invoke("markdown:get-settings"),
    saveSettings: (settings: unknown) => ipcRenderer.invoke("markdown:save-settings", settings),
    listEngines: () => ipcRenderer.invoke("markdown:list-engines"),
    installDocling: () => ipcRenderer.invoke("markdown:install-docling"),
    convertWithDocling: (bytes: number[], settings: unknown) => ipcRenderer.invoke("markdown:convert-docling", bytes, settings)
  },
  onFullScreenChange: (callback: (enabled: boolean) => void) => {
    const listener = (_event: unknown, enabled: boolean) => callback(enabled);
    ipcRenderer.on("window:full-screen-change", listener);
    return () => ipcRenderer.removeListener("window:full-screen-change", listener);
  },
  onWindowRequestClose: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("window:request-close", listener);
    return () => ipcRenderer.removeListener("window:request-close", listener);
  },
  onOpenFile: (callback: (filePath: string) => void) => {
    const listener = (_event: unknown, filePath: string) => callback(filePath);
    ipcRenderer.on("app:open-file", listener);
    return () => ipcRenderer.removeListener("app:open-file", listener);
  },
  onOpenFiles: (callback: (filePaths: string[]) => void) => {
    const listener = (_event: unknown, filePaths: string[]) => callback(filePaths);
    ipcRenderer.on("app:open-files", listener);
    return () => ipcRenderer.removeListener("app:open-files", listener);
  }
});
