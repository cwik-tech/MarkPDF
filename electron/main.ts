import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import Store from "electron-store";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

let pendingOpenPath: string | null = null;
const store = new Store<{ recentFiles: string[] }>({
  defaults: {
    recentFiles: []
  }
});

function addRecentFile(filePath: string) {
  const recentFiles = store.get("recentFiles", []);
  store.set("recentFiles", [filePath, ...recentFiles.filter((item) => item !== filePath)].slice(0, 12));
}

const createWindow = async (filePath?: string) => {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    title: "Open PDF Reader",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1f2633" : "#f5f6f8",
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.js", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(fileURLToPath(new URL("../dist/index.html", import.meta.url)));
  }

  if (filePath) {
    window.webContents.once("did-finish-load", () => {
      window.webContents.send("app:open-file", filePath);
    });
  }

  return window;
};

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (!app.isReady()) {
    pendingOpenPath = filePath;
    return;
  }
  void createWindow(filePath);
});

app.whenReady().then(async () => {
  await createWindow(pendingOpenPath ?? undefined);

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
    title: "Open PDF",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "PDF files", extensions: ["pdf"] }]
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

ipcMain.handle("file:read-pdf", async (_event, filePath: string) => {
  const data = await readFile(filePath);
  addRecentFile(filePath);
  return {
    path: filePath,
    name: basename(filePath),
    bytes: Array.from(data)
  };
});

ipcMain.handle("file:write-pdf", async (_event, filePath: string, bytes: number[]) => {
  await writeFile(filePath, Buffer.from(bytes));
  addRecentFile(filePath);
  return { path: filePath, name: basename(filePath) };
});

ipcMain.handle("window:new-for-file", async (_event, filePath: string) => {
  await createWindow(filePath);
});

ipcMain.handle("shell:show-item", async (_event, filePath: string) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle("recent:list", async () => store.get("recentFiles", []));

ipcMain.handle("recent:clear", async () => {
  store.set("recentFiles", []);
  return [];
});
