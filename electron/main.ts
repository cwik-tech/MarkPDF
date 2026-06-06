import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, shell } from "electron";
import type { MessageBoxOptions } from "electron";
import Store from "electron-store";
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deleteAIProvider,
  detectLocalAgents,
  listAIProviders,
  saveAIProvider,
  setLocalAgentEnabled,
  validateAIProvider,
  type AIProviderInput,
  type AIStoreSchema
} from "./ai.js";
import {
  clearSemanticDatabase,
  defaultSemanticSearchSettings,
  getSemanticDatabaseInfo,
  loadSemanticDatabase,
  saveSemanticDatabase,
  type SemanticSearchSettings
} from "./semantic.js";

let pendingOpenPaths: string[] = [];
let openPathFlushTimer: NodeJS.Timeout | null = null;
const appIconPath = fileURLToPath(new URL("../build/icon.png", import.meta.url));
const confirmedCloseWindows = new WeakSet<BrowserWindow>();
const store = new Store<AIStoreSchema>({
  defaults: {
    recentFiles: [],
    aiProviders: [],
    localAgentEnabled: {},
    semanticSearch: defaultSemanticSearchSettings
  }
});
const imageMimeTypes = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"]
]);

function addRecentFile(filePath: string) {
  const recentFiles = store.get("recentFiles", []);
  store.set("recentFiles", [filePath, ...recentFiles.filter((item) => item !== filePath)].slice(0, 12));
}

function imageMimeTypeForPath(filePath: string) {
  return imageMimeTypes.get(extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

function removeRecentFile(filePath: string) {
  const recentFiles = store.get("recentFiles", []);
  const nextRecentFiles = recentFiles.filter((item) => item !== filePath);
  store.set("recentFiles", nextRecentFiles);
  return nextRecentFiles;
}

function setDockIcon() {
  if (process.platform !== "darwin") return;

  const dockIcon = nativeImage.createFromPath(appIconPath);
  if (!dockIcon.isEmpty()) {
    app.dock?.setIcon(dockIcon);
  }
}

function queueOpenPath(filePath: string) {
  pendingOpenPaths = [...pendingOpenPaths.filter((item) => item !== filePath), filePath];

  if (openPathFlushTimer) {
    clearTimeout(openPathFlushTimer);
  }

  openPathFlushTimer = setTimeout(() => {
    const paths = pendingOpenPaths;
    pendingOpenPaths = [];
    openPathFlushTimer = null;
    void createWindow(paths);
  }, 150);
}

const createWindow = async (filePaths: string[] = []) => {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: "Open PDF Reader",
    icon: appIconPath,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1f2633" : "#f5f6f8",
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.js", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.on("close", (event) => {
    if (confirmedCloseWindows.has(window)) {
      confirmedCloseWindows.delete(window);
      return;
    }

    event.preventDefault();
    window.webContents.send("window:request-close");
  });

  if (filePaths.length > 0) {
    window.webContents.once("did-finish-load", () => {
      window.webContents.send("app:open-files", filePaths);
    });
  }

  if (process.env.VITE_DEV_SERVER_URL) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(fileURLToPath(new URL("../dist/index.html", import.meta.url)));
  }

  window.on("enter-full-screen", () => {
    window.webContents.send("window:full-screen-change", true);
  });

  window.on("leave-full-screen", () => {
    window.webContents.send("window:full-screen-change", false);
  });

  return window;
};

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (!app.isReady()) {
    pendingOpenPaths = [...pendingOpenPaths.filter((item) => item !== filePath), filePath];
    return;
  }
  queueOpenPath(filePath);
});

app.whenReady().then(async () => {
  setDockIcon();
  const initialOpenPaths = pendingOpenPaths;
  pendingOpenPaths = [];
  await createWindow(initialOpenPaths);

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("dialog:open-pdf", async () => {
  const result = await dialog.showOpenDialog({
    title: "Open PDF or Images",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "PDF and image files", extensions: ["pdf", "png", "jpg", "jpeg", "webp", "gif"] },
      { name: "PDF files", extensions: ["pdf"] },
      { name: "Image files", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }
    ]
  });

  if (result.canceled) {
    return [];
  }

  return result.filePaths;
});

ipcMain.handle("dialog:save-pdf", async (_event, defaultPath?: string) => {
  const result = await dialog.showSaveDialog({
    title: "Save PDF",
    defaultPath,
    filters: [{ name: "PDF files", extensions: ["pdf"] }]
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  return result.filePath;
});

ipcMain.handle("dialog:confirm-unsaved", async (event, documentName?: string) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const options: MessageBoxOptions = {
    type: "warning",
    title: "Unsaved changes",
    message: documentName ? `Save changes to "${documentName}" before closing?` : "Save changes before closing?",
    detail: "Your changes will be lost if you do not save them.",
    buttons: ["Save", "Discard", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  };
  const result = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);

  return (["save", "discard", "cancel"] as const)[result.response] ?? "cancel";
});

ipcMain.handle("file:read-pdf", async (_event, filePath: string) => {
  const data = await readFile(filePath);
  addRecentFile(filePath);
  return {
    path: filePath,
    name: basename(filePath),
    bytes: Array.from(data)
  };
});

ipcMain.handle("file:read-image", async (_event, filePath: string) => {
  const data = await readFile(filePath);
  return {
    path: filePath,
    name: basename(filePath),
    mimeType: imageMimeTypeForPath(filePath),
    bytes: Array.from(data)
  };
});

ipcMain.handle("file:write-pdf", async (_event, filePath: string, bytes: number[]) => {
  await writeFile(filePath, Buffer.from(bytes));
  addRecentFile(filePath);
  return { path: filePath, name: basename(filePath) };
});

ipcMain.handle("window:new-for-file", async (_event, filePath: string) => {
  await createWindow([filePath]);
});

ipcMain.handle("window:set-full-screen", async (event, enabled: boolean) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  window?.setFullScreen(enabled);
  return window?.isFullScreen() ?? false;
});

ipcMain.handle("window:is-full-screen", async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window?.isFullScreen() ?? false;
});

ipcMain.handle("window:close-after-confirm", async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  confirmedCloseWindows.add(window);
  window.close();
});

ipcMain.handle("shell:show-item", async (_event, filePath: string) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle("recent:list", async () => store.get("recentFiles", []));

ipcMain.handle("recent:remove", async (_event, filePath: string) => removeRecentFile(filePath));

ipcMain.handle("semantic:get-settings", async () => store.get("semanticSearch", defaultSemanticSearchSettings));

ipcMain.handle("semantic:save-settings", async (_event, settings: Partial<SemanticSearchSettings>) => {
  const current = store.get("semanticSearch", defaultSemanticSearchSettings);
  const next = {
    ...current,
    ...settings,
    downloadedModelIds: settings.downloadedModelIds ?? current.downloadedModelIds
  };
  store.set("semanticSearch", next);
  return next;
});

ipcMain.handle("semantic:mark-model-downloaded", async (_event, modelId: string) => {
  const current = store.get("semanticSearch", defaultSemanticSearchSettings);
  const next = {
    ...current,
    downloadedModelIds: [...new Set([...current.downloadedModelIds, modelId])]
  };
  store.set("semanticSearch", next);
  return next;
});

ipcMain.handle("semantic:remove-model", async (_event, modelId: string) => {
  const current = store.get("semanticSearch", defaultSemanticSearchSettings);
  const downloadedModelIds = current.downloadedModelIds.filter((id) => id !== modelId);
  const next = {
    ...current,
    downloadedModelIds,
    activeModelId: current.activeModelId === modelId && downloadedModelIds[0] ? downloadedModelIds[0] : current.activeModelId
  };
  store.set("semanticSearch", next);
  return next;
});

ipcMain.handle("semantic:load-db", async () => loadSemanticDatabase());

ipcMain.handle("semantic:save-db", async (_event, bytes: number[]) => {
  await saveSemanticDatabase(bytes);
});

ipcMain.handle("semantic:clear-db", async () => {
  await clearSemanticDatabase();
  return getSemanticDatabaseInfo();
});

ipcMain.handle("semantic:db-info", async () => getSemanticDatabaseInfo());

ipcMain.handle("recent:clear", async () => {
  store.set("recentFiles", []);
  return [];
});

ipcMain.handle("ai:list-providers", async () => listAIProviders(store));

ipcMain.handle("ai:save-provider", async (_event, provider: AIProviderInput) => saveAIProvider(store, provider));

ipcMain.handle("ai:delete-provider", async (_event, id: string) => {
  deleteAIProvider(store, id);
});

ipcMain.handle("ai:validate-provider", async (_event, id: string) => validateAIProvider(store, id));

ipcMain.handle("ai:fetch-provider-models", async (_event, id: string) => validateAIProvider(store, id));

ipcMain.handle("ai:list-local-agents", async () => detectLocalAgents(store));

ipcMain.handle("ai:refresh-local-agents", async () => detectLocalAgents(store));

ipcMain.handle("ai:set-local-agent-enabled", async (_event, id: string, enabled: boolean) => {
  setLocalAgentEnabled(store, id, enabled);
  return detectLocalAgents(store);
});
