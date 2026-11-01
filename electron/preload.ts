import type { FolderAccessReply } from "./folderAccess.js";
import { parsePreparationReply, type PreparationReply } from "../dist-core/agent/preparation.js";
import {
  parseRevealCommand,
  parseSuggestCommand,
  type RevealCommand,
  type RevealOutcome,
  type SuggestCommand,
  type SuggestOutcome,
} from "../dist-core/agent/desktopRequests.js";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { parseSemanticProgressEvent } from "../dist-core/ipc/progress.js";

/**
 * One request channel from main to the window: commands checked with core's parser, exactly one
 * answer for each, and a short queue for commands that arrive before the window has registered its
 * handler — a document an agent opened, or a cold start. The listener is registered as the preload
 * runs, before any page script, so no command can arrive unheard.
 */
function agentChannel<Command extends { requestId: string }, Outcome>(
  requestChannel: string,
  replyChannel: string,
  parse: (value: unknown) => Command | null,
) {
  let handler: ((command: Command) => Promise<Outcome>) | null = null;
  const queue: Array<{ requestId: string; value: unknown }> = [];
  const fail = (requestId: string, message: string): void => {
    ipcRenderer.send(replyChannel, requestId, { status: "failed", reason: "invalid_request", message });
  };
  const answer = (requestId: string, value: unknown): void => {
    const command = parse(value);
    if (command === null || command.requestId !== requestId) {
      fail(requestId, "The window received an invalid request.");
      return;
    }
    const current = handler;
    if (current === null) {
      queue.push({ requestId, value });
      return;
    }
    void current(command)
      .then((outcome) => ipcRenderer.send(replyChannel, requestId, outcome))
      .catch(() => fail(requestId, "The window could not carry out the request."));
  };
  ipcRenderer.on(requestChannel, (_event, requestId: unknown, value: unknown) => {
    if (typeof requestId === "string" && queue.length < 16) answer(requestId, value);
  });
  return (callback: (command: Command) => Promise<Outcome>) => {
    handler = callback;
    for (const queued of queue.splice(0)) answer(queued.requestId, queued.value);
    return () => {
      if (handler === callback) handler = null;
    };
  };
}

const onRevealRequest = agentChannel<RevealCommand, RevealOutcome>("agent:reveal", "agent:revealed", parseRevealCommand);
const onSuggestionRequest = agentChannel<SuggestCommand, SuggestOutcome>("agent:suggest", "agent:suggested", parseSuggestCommand);

contextBridge.exposeInMainWorld("pdfReader", {
  agentPreparationWindow: process.argv.includes("--markpdf-agent-window"),
  cancelPreparation: () => ipcRenderer.send("agent:cancel-current"),
  checkPreparationSource: (path: string, bytes: Uint8Array) => ipcRenderer.invoke("agent:check-source", path, bytes),
  preparationReady: (path: string) => ipcRenderer.send("agent:ready", path),
  onCancelPreparation: (callback: () => void) => { ipcRenderer.on("agent:cancel", callback); return () => ipcRenderer.removeListener("agent:cancel", callback); },
  prepareDocument: async () => parsePreparationReply(await ipcRenderer.invoke("agent:prepare-active")),
  onPrepareDocument: (callback: (path?: string) => Promise<PreparationReply>) => {
    const listener = (_event: Electron.IpcRendererEvent, id: unknown, path: unknown): void => {
      if (typeof id !== "string") return;
      void callback(typeof path === "string" ? path : undefined).then((reply) => ipcRenderer.send("agent:prepared", id, reply)).catch(() => ipcRenderer.send("agent:prepared", id, { status: "failed", save: "unknown", reason: "Preparation failed" }));
    };
    ipcRenderer.on("agent:prepare", listener);
    return () => ipcRenderer.removeListener("agent:prepare", listener);
  },
  savePreparation: (path: string, source: Uint8Array, bytes: Uint8Array) => ipcRenderer.invoke("agent:save", path, source, bytes),
  // An agent asks this window to show a passage, or to hold a suggestion for the person.
  onRevealRequest,
  onSuggestionRequest,
  // A short sentence from the main process about an agent's request, such as an ignored link.
  onAgentNotice: (callback: (text: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, text: unknown): void => {
      if (typeof text === "string" && text.length > 0 && text.length <= 300) callback(text);
    };
    ipcRenderer.on("agent:notice", listener);
    return () => ipcRenderer.removeListener("agent:notice", listener);
  },
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  openPdfDialog: () => ipcRenderer.invoke("dialog:open-pdf"),
  savePdfDialog: (defaultPath?: string) =>
    ipcRenderer.invoke("dialog:save-pdf", defaultPath),
  saveMarkdownDialog: (defaultPath?: string) =>
    ipcRenderer.invoke("dialog:save-markdown", defaultPath),
  saveDiagramSvg: (fileName: string, svg: string) =>
    ipcRenderer.invoke("dialog:save-diagram-svg", fileName, svg),
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
  cancelWindowClose: () => ipcRenderer.invoke("window:cancel-close"),
  showItemInFolder: (filePath: string) =>
    ipcRenderer.invoke("shell:show-item", filePath),
  // An address a document named. Main decides which schemes may reach the desktop.
  openExternalUrl: (url: string) =>
    ipcRenderer.invoke("shell:open-external", url),
  addRecentFile: (filePath: string) =>
    ipcRenderer.invoke("recent:add", filePath),
  listRecentFiles: () => ipcRenderer.invoke("recent:list"),
  removeRecentFile: (filePath: string) =>
    ipcRenderer.invoke("recent:remove", filePath),
  clearRecentFiles: () => ipcRenderer.invoke("recent:clear"),
  readyForOpenFiles: () =>
    ipcRenderer.invoke("app:renderer-ready-for-open-files"),
  openDocuments: {
    // What this window is showing, for processes that cannot see it. Markdown text crosses only
    // so main can maintain a private bounded snapshot; no PDF bytes cross here.
    publish: (report: unknown) =>
      ipcRenderer.invoke("open-documents:publish", report),
  },
  folderAccess: {
    list: (): Promise<FolderAccessReply> => ipcRenderer.invoke("folder-access:list"),
    setLevel: (path: string, level: "read" | "read-write"): Promise<FolderAccessReply> => ipcRenderer.invoke("folder-access:set-level", { path, level }),
    add: (): Promise<FolderAccessReply> => ipcRenderer.invoke("folder-access:add"),
    remove: (path: string): Promise<FolderAccessReply> => ipcRenderer.invoke("folder-access:remove", { path }),
  },
  cliInstall: {
    getStatus: () => ipcRenderer.invoke("cli-install:status"),
    install: () => ipcRenderer.invoke("cli-install:install"),
    uninstall: () => ipcRenderer.invoke("cli-install:uninstall"),
  },
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
    removeModel: (modelId: string) =>
      ipcRenderer.invoke("semantic:remove-model", modelId),
    listModels: () => ipcRenderer.invoke("semantic:list-models"),
    indexDocument: (request: unknown) =>
      ipcRenderer.invoke("semantic:index", request),
    cancelIndex: (jobId: string) => ipcRenderer.invoke("semantic:cancel", jobId),
    search: (request: unknown) => ipcRenderer.invoke("semantic:search", request),
    searchLibrary: (request: unknown) => ipcRenderer.invoke("semantic:search-library", request),
    getDocument: (contentHash: string) =>
      ipcRenderer.invoke("semantic:get-document", contentHash),
    deleteDocument: (contentHash: string) =>
      ipcRenderer.invoke("semantic:delete-document", contentHash),
    downloadModel: (request: unknown) =>
      ipcRenderer.invoke("semantic:download-model", request),
    clearDatabase: () => ipcRenderer.invoke("semantic:clear-db"),
    databaseInfo: () => ipcRenderer.invoke("semantic:db-info"),
  },
  onSemanticProgress: (callback: (event: unknown) => void) => {
    // Narrow here, using core's parser. The renderer must not import core, and a malformed
    // event must never reach tab state — it drives the visible status badge.
    const listener = (_event: unknown, payload: unknown) => {
      const parsed = parseSemanticProgressEvent(payload);
      if (parsed !== null) callback(parsed);
    };
    ipcRenderer.on("semantic:progress", listener);
    return () => ipcRenderer.removeListener("semantic:progress", listener);
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
