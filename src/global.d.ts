export {};

declare global {
  interface Window {
    pdfReader?: {
      openPdfDialog: () => Promise<string[]>;
      savePdfDialog: (defaultPath?: string) => Promise<string | null>;
      readPdf: (filePath: string) => Promise<{ path: string; name: string; bytes: number[] }>;
      writePdf: (filePath: string, bytes: number[]) => Promise<{ path: string; name: string }>;
      openFileInNewWindow: (filePath: string) => Promise<void>;
      showItemInFolder: (filePath: string) => Promise<void>;
      onOpenFile: (callback: (filePath: string) => void) => () => void;
    };
  }
}
