export {};

export type AIProviderKind =
  | "openai-compatible"
  | "openrouter"
  | "ollama"
  | "lmstudio"
  | "anthropic"
  | "custom";

export interface AIModelInfo {
  id: string;
  name: string;
  enabled: boolean;
}

export interface AIProviderView {
  id: string;
  kind: AIProviderKind;
  name: string;
  baseUrl: string;
  enabled: boolean;
  models: AIModelInfo[];
  status: "unknown" | "connected" | "error";
  error?: string;
  lastCheckedAt?: string;
  hasApiKey: boolean;
  apiKeyPreview?: string;
}

export interface AIProviderInput {
  id?: string;
  kind: AIProviderKind;
  name: string;
  baseUrl: string;
  apiKey?: string;
  enabled: boolean;
  models?: AIModelInfo[];
}

export interface LocalAgentInfo {
  id: string;
  kind: "codex" | "claude-code" | "gemini-cli" | "qwen-cli";
  name: string;
  command: string;
  path?: string;
  available: boolean;
  enabled: boolean;
  version?: string;
  error?: string;
}

export type SemanticChunkingProfile = "precise" | "balanced" | "contextual";

export interface SemanticSearchSettings {
  enabled: boolean;
  activeModelId: string;
  chunkingProfile: SemanticChunkingProfile;
  minSemanticScore: number;
  downloadedModelIds: string[];
}

export interface SemanticDatabaseInfo {
  sizeBytes: number;
  documentCount: number;
  chunkCount: number;
  schemaVersion: number;
  concurrencyDegraded: boolean;
}

export interface CuratedEmbeddingModel {
  id: string;
  name: string;
  description: string;
  dimensions: number;
  approxSizeMb: number;
  badge?: string;
  queryPrefix?: string;
}

export interface SemanticIndexRequest {
  jobId: string;
  source: { kind: "bytes"; bytes: Uint8Array | number[]; path?: string } | { kind: "path"; path: string };
  name: string;
  /**
   * No page text crosses this boundary in either direction. The main process reads the document
   * itself, including the pages that have to be recognised, so that every surface indexes the same
   * words for the same file.
   */
  chunkingProfile: SemanticChunkingProfile;
  force?: boolean;
}

export interface SemanticIndexedResult {
  /**
   * `incomplete` is a success with a gap in it: the document is stored and searchable, and at least
   * one page could not be read. Mirrors core's own status so the window cannot quietly treat it as
   * ready.
   */
  status: "ready" | "reused" | "empty" | "incomplete";
  contentHash: string;
  documentId: number;
  pageCount: number;
  chunkCount: number;
  textSource: "pdf" | "ocr" | "mixed" | "none";
  /** Pages nothing could read, ascending. Empty unless `status` is `incomplete`. */
  unresolvedPages: number[];
}

/**
 * A cancelled run carries a status and nothing else, because it produced nothing else. Mirrors
 * the union `core/index/indexDocument.ts` returns, so the renderer cannot read a content hash
 * from a run that never computed one.
 */
export type SemanticIndexResult = SemanticIndexedResult | { status: "cancelled" };

export interface SemanticSearchRequest {
  contentHash: string;
  query: string;
  chunkingProfile: SemanticChunkingProfile;
  topK?: number;
  minScore?: number;
}

export interface SemanticIndexedDocument {
  id: number;
  contentHash: string;
  name: string;
  filePath: string | null;
  pageCount: number;
  textSource: string;
  createdAt: string;
  lastOpenedAt: string;
}

export interface SemanticProgressEvent {
  jobId: string;
  kind: "index" | "model";
  progress: {
    status: "checking" | "indexing" | "downloading" | "ready";
    current?: number;
    total?: number;
    message?: string;
  };
}

export type MarkdownEngineId = "auto" | "builtin-text" | "docling-managed" | "docling-vlm-smoldocling";
export type MarkdownExportMode = "readable" | "page-preserving";
type BytePayload = Uint8Array | number[];

export interface MarkdownEngineAvailability {
  id: MarkdownEngineId;
  name: string;
  available: boolean;
  version?: string;
  error?: string;
}

export interface MarkdownInstallProgress {
  status: "checking" | "creating-env" | "installing" | "ready" | "error";
  message: string;
  current?: number;
  total?: number;
}

export interface MarkdownExportSettings {
  defaultEngine: MarkdownEngineId;
  exportMode: MarkdownExportMode;
  includePageMarkers: boolean;
  useOcrFallback: boolean;
  includeAnnotations: boolean;
  includeImageDescriptions: boolean;
  aiCleanup: boolean;
  engineSelectionExplicit?: boolean;
}

export type DefaultAppFileTypeId = "pdf" | "markdown";

export interface DefaultAppFileTypeStatus {
  id: DefaultAppFileTypeId;
  label: string;
  description: string;
  isDefault: boolean;
  currentAppName: string | null;
  currentBundleId: string | null;
}

export interface DefaultAppStatus {
  supported: boolean;
  reason?: string;
  bundleId: string | null;
  bundlePath: string | null;
  fileTypes: DefaultAppFileTypeStatus[];
}

/**
 * What the `markpdf` command on this machine is.
 *
 * Mirrored from `electron/cliInstall.ts` the way every other IPC contract in this file is: the
 * renderer never imports from `core/` or `dist-core/`, so the shape crosses as a declaration.
 * `core/modelParity.test.ts` is the precedent for keeping a mirrored declaration honest.
 */
export type ShimDifference = "version" | "electronPath" | "entryPoint" | "dataDir";

export type CliInstallState =
  | { state: "not-installed"; path: string }
  | { state: "current"; path: string }
  | { state: "stale"; path: string; installedVersion: string; differences: ShimDifference[] }
  | { state: "points-elsewhere"; path: string; installedAppPath: string }
  | { state: "foreign"; path: string }
  | { state: "shadowed"; path: string; shadowedBy: string }
  | { state: "not-on-path"; path: string }
  | { state: "not-executable"; path: string }
  | { state: "path-unknown"; path: string };

export interface CliInstallStatus {
  supported: boolean;
  reason?: string;
  command: string;
  installDirectory: string;
  installPath: string;
  version: string;
  state: CliInstallState;
  pathHint: string;
  /** True when the directory is one the shell looks in without the person changing anything. */
  onDefaultPath: boolean;
}

export interface CliInstallResult {
  ok: boolean;
  reason?: string;
  status: CliInstallStatus;
}

/**
 * One open tab, as this window reports it to the main process.
 *
 * The mirror of `OpenDocumentRecord` in core, which is where it is validated and written. It
 * carries no document text and no bytes; `path` is used only to prove read permission for a
 * document that is not yet indexed, and never leaves the machine's own processes.
 */
export interface ReportedOpenDocument {
  tabId: string;
  kind: "pdf" | "markdown";
  name: string;
  path: string | null;
  pageCount: number;
  currentPage: number | null;
  contentHash: string | null;
  /** Private IPC payload. The main process writes it to a bounded 0600 snapshot, never metadata. */
  contentSnapshot: string | null;
  unsavedChanges: boolean;
}

export interface OpenDocumentsReport {
  activeTabId: string | null;
  documents: ReportedOpenDocument[];
}

declare global {
  interface Window {
    pdfReader?: {
      getPathForFile: (file: File) => string;
      openPdfDialog: () => Promise<string[]>;
      savePdfDialog: (defaultPath?: string) => Promise<string | null>;
      saveMarkdownDialog: (defaultPath?: string) => Promise<string | null>;
      confirmUnsaved: (
        documentName?: string,
      ) => Promise<"save" | "discard" | "cancel">;
      readPdf: (
        filePath: string,
      ) => Promise<{ path: string; name: string; bytes: Uint8Array }>;
      readImage: (
        filePath: string,
      ) => Promise<{
        path: string;
        name: string;
        mimeType: string;
        bytes: Uint8Array;
      }>;
      readMarkdown: (
        filePath: string,
      ) => Promise<{ path: string; name: string; markdown: string; baseUrl: string }>;
      writePdf: (
        filePath: string,
        bytes: BytePayload,
      ) => Promise<{ path: string; name: string }>;
      writeMarkdown: (
        filePath: string,
        markdown: string,
      ) => Promise<{ path: string; name: string }>;
      openFileInNewWindow: (filePath: string) => Promise<void>;
      setFullScreen: (enabled: boolean) => Promise<boolean>;
      isFullScreen: () => Promise<boolean>;
      closeWindowAfterConfirm: () => Promise<void>;
      showItemInFolder: (filePath: string) => Promise<void>;
      addRecentFile: (filePath: string) => Promise<string[]>;
      listRecentFiles: () => Promise<string[]>;
      removeRecentFile: (filePath: string) => Promise<string[]>;
      clearRecentFiles: () => Promise<string[]>;
      readyForOpenFiles: () => Promise<void>;
      openDocuments: {
        publish: (report: OpenDocumentsReport) => Promise<void>;
      };
      cliInstall: {
        getStatus: () => Promise<CliInstallStatus>;
        install: () => Promise<CliInstallResult>;
        uninstall: () => Promise<CliInstallResult>;
      };
      defaultApp: {
        getStatus: () => Promise<DefaultAppStatus>;
        setAsDefault: (
          fileTypeIds: DefaultAppFileTypeId[],
        ) => Promise<DefaultAppStatus>;
      };
      ai: {
        listProviders: () => Promise<AIProviderView[]>;
        saveProvider: (provider: AIProviderInput) => Promise<AIProviderView>;
        deleteProvider: (id: string) => Promise<void>;
        validateProvider: (id: string) => Promise<AIProviderView>;
        fetchProviderModels: (id: string) => Promise<AIProviderView>;
        listLocalAgents: () => Promise<LocalAgentInfo[]>;
        refreshLocalAgents: () => Promise<LocalAgentInfo[]>;
        setLocalAgentEnabled: (
          id: string,
          enabled: boolean,
        ) => Promise<LocalAgentInfo[]>;
      };
      semantic: {
        getSettings: () => Promise<SemanticSearchSettings>;
        saveSettings: (
          settings: Partial<SemanticSearchSettings>,
        ) => Promise<SemanticSearchSettings>;
        removeModel: (modelId: string) => Promise<SemanticSearchSettings>;
        listModels: () => Promise<CuratedEmbeddingModel[]>;
        indexDocument: (
          request: SemanticIndexRequest,
        ) => Promise<SemanticIndexResult>;
        cancelIndex: (jobId: string) => Promise<boolean>;
        search: (
          request: SemanticSearchRequest,
        ) => Promise<import("./types").SemanticSearchResult[]>;
        getDocument: (
          contentHash: string,
        ) => Promise<SemanticIndexedDocument | null>;
        deleteDocument: (contentHash: string) => Promise<boolean>;
        downloadModel: (request: {
          jobId: string;
          modelId?: string;
        }) => Promise<SemanticSearchSettings>;
        clearDatabase: () => Promise<SemanticDatabaseInfo>;
        databaseInfo: () => Promise<SemanticDatabaseInfo>;
      };
      markdown: {
        getSettings: () => Promise<MarkdownExportSettings>;
        saveSettings: (
          settings: Partial<MarkdownExportSettings>,
        ) => Promise<MarkdownExportSettings>;
        listEngines: () => Promise<MarkdownEngineAvailability[]>;
        installState: () => Promise<MarkdownInstallProgress | null>;
        installDocling: () => Promise<MarkdownEngineAvailability[]>;
        convertWithDocling: (
          bytes: BytePayload,
          settings: MarkdownExportSettings,
          outputMarkdownPath?: string,
        ) => Promise<{
          markdown: string;
          engineId: MarkdownEngineId;
          warnings: string[];
        }>;
      };
      onSemanticProgress: (
        callback: (event: SemanticProgressEvent) => void,
      ) => () => void;
      onMarkdownInstallProgress: (
        callback: (progress: MarkdownInstallProgress) => void,
      ) => () => void;
      onFullScreenChange: (callback: (enabled: boolean) => void) => () => void;
      onWindowRequestClose: (callback: () => void) => () => void;
      onOpenFile: (callback: (filePath: string) => void) => () => void;
      onOpenFiles: (callback: (filePaths: string[]) => void) => () => void;
      onRecentFilesChanged: (
        callback: (filePaths: string[]) => void,
      ) => () => void;
    };
  }
}
