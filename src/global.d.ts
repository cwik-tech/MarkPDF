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
        markModelDownloaded: (
          modelId: string,
        ) => Promise<SemanticSearchSettings>;
        removeModel: (modelId: string) => Promise<SemanticSearchSettings>;
        loadDatabase: () => Promise<number[] | null>;
        saveDatabase: (bytes: BytePayload) => Promise<void>;
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
