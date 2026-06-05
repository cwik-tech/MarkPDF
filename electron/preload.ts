import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pdfReader", {
  openPdfDialog: () => ipcRenderer.invoke("dialog:open-pdf"),
  savePdfDialog: (defaultPath?: string) => ipcRenderer.invoke("dialog:save-pdf", defaultPath),
  readPdf: (filePath: string) => ipcRenderer.invoke("file:read-pdf", filePath),
  writePdf: (filePath: string, bytes: number[]) => ipcRenderer.invoke("file:write-pdf", filePath, bytes),
  openFileInNewWindow: (filePath: string) => ipcRenderer.invoke("window:new-for-file", filePath),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke("shell:show-item", filePath),
  listRecentFiles: () => ipcRenderer.invoke("recent:list"),
  clearRecentFiles: () => ipcRenderer.invoke("recent:clear"),
  onOpenFile: (callback: (filePath: string) => void) => {
    const listener = (_event: unknown, filePath: string) => callback(filePath);
    ipcRenderer.on("app:open-file", listener);
    return () => ipcRenderer.removeListener("app:open-file", listener);
  }
});
