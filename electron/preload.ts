import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pdfReader", {
  openPdfDialog: () => ipcRenderer.invoke("dialog:open-pdf"),
  savePdfDialog: (defaultPath?: string) => ipcRenderer.invoke("dialog:save-pdf", defaultPath),
  confirmUnsaved: (documentName?: string) => ipcRenderer.invoke("dialog:confirm-unsaved", documentName),
  readPdf: (filePath: string) => ipcRenderer.invoke("file:read-pdf", filePath),
  writePdf: (filePath: string, bytes: number[]) => ipcRenderer.invoke("file:write-pdf", filePath, bytes),
  openFileInNewWindow: (filePath: string) => ipcRenderer.invoke("window:new-for-file", filePath),
  setFullScreen: (enabled: boolean) => ipcRenderer.invoke("window:set-full-screen", enabled),
  isFullScreen: () => ipcRenderer.invoke("window:is-full-screen"),
  closeWindowAfterConfirm: () => ipcRenderer.invoke("window:close-after-confirm"),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke("shell:show-item", filePath),
  listRecentFiles: () => ipcRenderer.invoke("recent:list"),
  clearRecentFiles: () => ipcRenderer.invoke("recent:clear"),
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
  }
});
