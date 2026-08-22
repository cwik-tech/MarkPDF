import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("pdfReader", {
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  openPdfDialog: () => ipcRenderer.invoke("dialog:open-pdf"),
  savePdfDialog: (defaultPath?: string) =>
    ipcRenderer.invoke("dialog:save-pdf", defaultPath),
  saveMarkdownDialog: (defaultPath?: string) =>
    ipcRenderer.invoke("dialog:save-markdown", defaultPath),
  confirmUnsaved: (documentName?: string) =>
    ipcRenderer.invoke("dialog:confirm-unsaved", documentName),
  readPdf: (filePath: string) => ipcRenderer.invoke("file:read-pdf", filePath),
  readImage: (filePath: string) =>
    ipcRenderer.invoke("file:read-image", filePath),
  readMarkdown: (filePath: string) =>
    ipcRenderer.invoke("file:read-markdown", filePath),
  writePdf: (filePath: string, bytes: Uint8Array | number[]) =>
    ipcRenderer.invoke("file:write-pdf", filePath, bytes),
  writeMarkdown: (filePath: string, markdown: string) =>
    ipcRenderer.invoke("file:write-markdown", filePath, markdown),
  openFileInNewWindow: (filePath: string) =>
    ipcRenderer.invoke("window:new-for-file", filePath),
  setFullScreen: (enabled: boolean) =>
    ipcRenderer.invoke("window:set-full-screen", enabled),
  isFullScreen: () => ipcRenderer.invoke("window:is-full-screen"),
  closeWindowAfterConfirm: () =>
    ipcRenderer.invoke("window:close-after-confirm"),
  showItemInFolder: (filePath: string) =>
    ipcRenderer.invoke("shell:show-item", filePath),
  addRecentFile: (filePath: string) =>
    ipcRenderer.invoke("recent:add", filePath),
  listRecentFiles: () => ipcRenderer.invoke("recent:list"),
  removeRecentFile: (filePath: string) =>
    ipcRenderer.invoke("recent:remove", filePath),
  clearRecentFiles: () => ipcRenderer.invoke("recent:clear"),
  readyForOpenFiles: () =>
    ipcRenderer.invoke("app:renderer-ready-for-open-files"),
  defaultApp: {
    getStatus: () => ipcRenderer.invoke("default-app:status"),
    setAsDefault: (fileTypeIds: string[]) =>
      ipcRenderer.invoke("default-app:set", fileTypeIds),
  },
  ai: {
    listProviders: () => ipcRenderer.invoke("ai:list-providers"),
    saveProvider: (provider: unknown) =>
      ipcRenderer.invoke("ai:save-provider", provider),
    deleteProvider: (id: string) =>
      ipcRenderer.invoke("ai:delete-provider", id),
    validateProvider: (id: string) =>
      ipcRenderer.invoke("ai:validate-provider", id),
    fetchProviderModels: (id: string) =>
      ipcRenderer.invoke("ai:fetch-provider-models", id),
    listLocalAgents: () => ipcRenderer.invoke("ai:list-local-agents"),
    refreshLocalAgents: () => ipcRenderer.invoke("ai:refresh-local-agents"),
    setLocalAgentEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke("ai:set-local-agent-enabled", id, enabled),
  },
  semantic: {
    getSettings: () => ipcRenderer.invoke("semantic:get-settings"),
    saveSettings: (settings: unknown) =>
      ipcRenderer.invoke("semantic:save-settings", settings),
    markModelDownloaded: (modelId: string) =>
      ipcRenderer.invoke("semantic:mark-model-downloaded", modelId),
    removeModel: (modelId: string) =>
      ipcRenderer.invoke("semantic:remove-model", modelId),
    loadDatabase: () => ipcRenderer.invoke("semantic:load-db"),
    saveDatabase: (bytes: Uint8Array | number[]) =>
      ipcRenderer.invoke("semantic:save-db", bytes),
    clearDatabase: () => ipcRenderer.invoke("semantic:clear-db"),
    databaseInfo: () => ipcRenderer.invoke("semantic:db-info"),
  },
  markdown: {
    getSettings: () => ipcRenderer.invoke("markdown:get-settings"),
    saveSettings: (settings: unknown) =>
      ipcRenderer.invoke("markdown:save-settings", settings),
    listEngines: () => ipcRenderer.invoke("markdown:list-engines"),
    installState: () => ipcRenderer.invoke("markdown:install-state"),
    installDocling: () => ipcRenderer.invoke("markdown:install-docling"),
    convertWithDocling: (
      bytes: Uint8Array | number[],
      settings: unknown,
      outputMarkdownPath?: string,
    ) => ipcRenderer.invoke("markdown:convert-docling", bytes, settings, outputMarkdownPath),
  },
  onMarkdownInstallProgress: (callback: (progress: unknown) => void) => {
    const listener = (_event: unknown, progress: unknown) => callback(progress);
    ipcRenderer.on("markdown:install-progress", listener);
    return () =>
      ipcRenderer.removeListener("markdown:install-progress", listener);
  },
  onFullScreenChange: (callback: (enabled: boolean) => void) => {
    const listener = (_event: unknown, enabled: boolean) => callback(enabled);
    ipcRenderer.on("window:full-screen-change", listener);
    return () =>
      ipcRenderer.removeListener("window:full-screen-change", listener);
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
    const listener = (_event: unknown, filePaths: string[]) =>
      callback(filePaths);
    ipcRenderer.on("app:open-files", listener);
    return () => ipcRenderer.removeListener("app:open-files", listener);
  },
  onRecentFilesChanged: (callback: (filePaths: string[]) => void) => {
    const listener = (_event: unknown, filePaths: string[]) =>
      callback(filePaths);
    ipcRenderer.on("recent:changed", listener);
    return () => ipcRenderer.removeListener("recent:changed", listener);
  },
});
