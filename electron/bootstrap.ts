import { app } from "electron";

type OpenFileBootstrapState = {
  pendingOpenPaths: string[];
  onOpenFile?: (filePath: string) => void;
  /** `markpdf://` addresses macOS delivered before the main module was ready for them. */
  pendingOpenUrls: string[];
  onOpenUrl?: (url: string) => void;
};

const bootstrapState: OpenFileBootstrapState = {
  pendingOpenPaths: [],
  pendingOpenUrls: []
};

function rememberOpenPath(filePath: string) {
  bootstrapState.pendingOpenPaths = [...bootstrapState.pendingOpenPaths.filter((item) => item !== filePath), filePath];
}

(globalThis as typeof globalThis & { markPdfOpenFileBootstrap?: OpenFileBootstrapState }).markPdfOpenFileBootstrap =
  bootstrapState;

app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (bootstrapState.onOpenFile) {
    bootstrapState.onOpenFile(filePath);
    return;
  }
  rememberOpenPath(filePath);
});

// An evidence link clicked in another application. On a cold start macOS delivers it before the
// main module has loaded, so it is held here the same way an opened file is.
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (bootstrapState.onOpenUrl) {
    bootstrapState.onOpenUrl(url);
    return;
  }
  if (bootstrapState.pendingOpenUrls.length < 8) bootstrapState.pendingOpenUrls.push(url);
});

await import("./main.js");
