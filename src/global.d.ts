export {};

export type AIProviderKind = "openai-compatible" | "openrouter" | "ollama" | "lmstudio" | "anthropic" | "custom";

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

declare global {
  interface Window {
    pdfReader?: {
      openPdfDialog: () => Promise<string[]>;
      savePdfDialog: (defaultPath?: string) => Promise<string | null>;
      confirmUnsaved: (documentName?: string) => Promise<"save" | "discard" | "cancel">;
      readPdf: (filePath: string) => Promise<{ path: string; name: string; bytes: number[] }>;
      readImage: (filePath: string) => Promise<{ path: string; name: string; mimeType: string; bytes: number[] }>;
      writePdf: (filePath: string, bytes: number[]) => Promise<{ path: string; name: string }>;
      openFileInNewWindow: (filePath: string) => Promise<void>;
      setFullScreen: (enabled: boolean) => Promise<boolean>;
      isFullScreen: () => Promise<boolean>;
      closeWindowAfterConfirm: () => Promise<void>;
      showItemInFolder: (filePath: string) => Promise<void>;
      listRecentFiles: () => Promise<string[]>;
      removeRecentFile: (filePath: string) => Promise<string[]>;
      clearRecentFiles: () => Promise<string[]>;
      ai: {
        listProviders: () => Promise<AIProviderView[]>;
        saveProvider: (provider: AIProviderInput) => Promise<AIProviderView>;
        deleteProvider: (id: string) => Promise<void>;
        validateProvider: (id: string) => Promise<AIProviderView>;
        fetchProviderModels: (id: string) => Promise<AIProviderView>;
        listLocalAgents: () => Promise<LocalAgentInfo[]>;
        refreshLocalAgents: () => Promise<LocalAgentInfo[]>;
        setLocalAgentEnabled: (id: string, enabled: boolean) => Promise<LocalAgentInfo[]>;
      };
      onFullScreenChange: (callback: (enabled: boolean) => void) => () => void;
      onWindowRequestClose: (callback: () => void) => () => void;
      onOpenFile: (callback: (filePath: string) => void) => () => void;
      onOpenFiles: (callback: (filePaths: string[]) => void) => () => void;
    };
  }
}
