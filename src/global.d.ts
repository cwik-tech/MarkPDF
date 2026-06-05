export {};

declare global {
  interface Window {
    pdfReader?: {
      openPdfDialog: () => Promise<string[]>;
      savePdfDialog: (defaultPath?: string) => Promise<string | null>;
      readPdf: (filePath: string) => Promise<{ path: string; name: string; bytes: number[] }>;
      writePdf: (filePath: string, bytes: number[]) => Promise<{ path: string; name: string }>;
      openFileInNewWindow: (filePath: string) => Promise<void>;
      setFullScreen: (enabled: boolean) => Promise<boolean>;
      isFullScreen: () => Promise<boolean>;
      showItemInFolder: (filePath: string) => Promise<void>;
      listRecentFiles: () => Promise<string[]>;
      clearRecentFiles: () => Promise<string[]>;
      onFullScreenChange: (callback: (enabled: boolean) => void) => () => void;
      onOpenFile: (callback: (filePath: string) => void) => () => void;
    };
  }
}
