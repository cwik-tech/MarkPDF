import { app } from "electron";

type OpenFileBootstrapState = {
  pendingOpenPaths: string[];
  onOpenFile?: (filePath: string) => void;
};

const bootstrapState: OpenFileBootstrapState = {
  pendingOpenPaths: []
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

await import("./main.js");
