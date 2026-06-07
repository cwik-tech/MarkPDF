import { app } from "electron";
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type MarkdownEngineId = "auto" | "builtin-text" | "docling-managed" | "docling-vlm-smoldocling";
export type MarkdownExportMode = "readable" | "page-preserving";

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

let currentInstallProgress: MarkdownInstallProgress | null = null;
const installProgressListeners = new Set<(progress: MarkdownInstallProgress) => void>();

export interface MarkdownExportSettings {
  defaultEngine: MarkdownEngineId;
  exportMode: MarkdownExportMode;
  includePageMarkers: boolean;
  useOcrFallback: boolean;
  includeAnnotations: boolean;
  aiCleanup: boolean;
  engineSelectionExplicit?: boolean;
}

export interface MarkdownStoreSchema {
  markdownExport: MarkdownExportSettings;
}

export const defaultMarkdownExportSettings: MarkdownExportSettings = {
  defaultEngine: "auto",
  exportMode: "readable",
  includePageMarkers: true,
  useOcrFallback: true,
  includeAnnotations: true,
  aiCleanup: false,
  engineSelectionExplicit: false
};

export function normalizeMarkdownExportSettings(
  settings?: Partial<MarkdownExportSettings>,
  options: { migrateLegacyDefaultEngine?: boolean } = {}
): MarkdownExportSettings {
  const defaultEngine =
    settings?.defaultEngine === "auto" ||
    settings?.defaultEngine === "builtin-text" ||
    settings?.defaultEngine === "docling-managed" ||
    settings?.defaultEngine === "docling-vlm-smoldocling"
      ? settings.defaultEngine
      : defaultMarkdownExportSettings.defaultEngine;
  const migratedDefaultEngine =
    options.migrateLegacyDefaultEngine &&
    defaultEngine === "docling-managed" &&
    settings?.engineSelectionExplicit !== true
      ? "auto"
      : defaultEngine;

  return {
    ...defaultMarkdownExportSettings,
    ...settings,
    defaultEngine: migratedDefaultEngine,
    engineSelectionExplicit: settings?.engineSelectionExplicit === true
  };
}

export function getManagedDoclingInstallProgress() {
  return currentInstallProgress;
}

function updateInstallProgress(progress: MarkdownInstallProgress) {
  currentInstallProgress = progress;
  for (const listener of installProgressListeners) {
    try {
      listener(progress);
    } catch {
      installProgressListeners.delete(listener);
    }
  }
}

function defaultPathEnv() {
  const segments = [
    process.env.PATH,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(":"));
  return [...new Set(segments)].join(":");
}

function doclingEngineDir() {
  return join(app.getPath("userData"), "markdown-engines", "docling");
}

function doclingVenvDir() {
  return join(doclingEngineDir(), ".venv");
}

function doclingExecutablePath() {
  return process.platform === "win32"
    ? join(doclingVenvDir(), "Scripts", "docling.exe")
    : join(doclingVenvDir(), "bin", "docling");
}

function pythonExecutablePath() {
  return process.platform === "win32"
    ? join(doclingVenvDir(), "Scripts", "python.exe")
    : join(doclingVenvDir(), "bin", "python");
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findPythonCommand() {
  updateInstallProgress({
    status: "checking",
    message: "Checking converter runtime",
    current: 1,
    total: 4
  });
  const candidates = process.platform === "win32" ? ["py", "python"] : ["python3", "python"];
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, process.platform === "win32" && candidate === "py" ? ["-3", "--version"] : ["--version"], {
        env: { ...process.env, PATH: defaultPathEnv() },
        timeout: 15000
      });
      return candidate;
    } catch {
      // Try the next Python command.
    }
  }
  throw new Error("Python 3 was not found. A bundled Python runtime is needed for fully offline Markdown converter installs.");
}

export async function getMarkdownEngineAvailability(): Promise<MarkdownEngineAvailability[]> {
  const engines: MarkdownEngineAvailability[] = [
    {
      id: "builtin-text",
      name: "Built-in text export",
      available: true
    }
  ];

  const doclingPath = doclingExecutablePath();
  if (await pathExists(doclingPath)) {
    try {
      const { stdout } = await execFileAsync(doclingPath, ["--version"], {
        env: { ...process.env, PATH: defaultPathEnv() },
        timeout: 15000
      });
      currentInstallProgress = {
        status: "ready",
        message: "Docling installed",
        current: 4,
        total: 4
      };
      engines.push({
        id: "docling-managed",
        name: "Docling",
        available: true,
        version: stdout.trim() || "Installed"
      });
      engines.push({
        id: "docling-vlm-smoldocling",
        name: "Docling VLM (SmolDocling)",
        available: true,
        version: stdout.trim() || "Installed"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The managed Docling engine could not be started.";
      engines.push({
        id: "docling-managed",
        name: "Docling",
        available: false,
        error: message
      });
      engines.push({
        id: "docling-vlm-smoldocling",
        name: "Docling VLM (SmolDocling)",
        available: false,
        error: message
      });
    }
  } else {
    engines.push({
      id: "docling-managed",
      name: "Docling",
      available: false,
      error: "Not installed. It will be prepared automatically."
    });
    engines.push({
      id: "docling-vlm-smoldocling",
      name: "Docling VLM (SmolDocling)",
      available: false,
      error: "Not installed. It will be prepared automatically."
    });
  }

  return engines;
}

let installPromise: Promise<MarkdownEngineAvailability[]> | null = null;

export async function installManagedDocling(onProgress?: (progress: MarkdownInstallProgress) => void) {
  if (onProgress) {
    installProgressListeners.add(onProgress);
    if (currentInstallProgress) {
      onProgress(currentInstallProgress);
    }
  }

  try {
    if (installPromise) return await installPromise;

    const doclingPath = doclingExecutablePath();
    if (await pathExists(doclingPath)) {
      updateInstallProgress({
        status: "ready",
        message: "Markdown converter ready",
        current: 4,
        total: 4
      });
      return getMarkdownEngineAvailability();
    }

    installPromise = (async () => {
      try {
        const pythonCommand = await findPythonCommand();
        const venvArgs = process.platform === "win32" && pythonCommand === "py"
          ? ["-3", "-m", "venv", doclingVenvDir()]
          : ["-m", "venv", doclingVenvDir()];

        updateInstallProgress({
          status: "creating-env",
          message: "Creating converter runtime",
          current: 2,
          total: 4
        });
        await execFileAsync(pythonCommand, venvArgs, {
          env: { ...process.env, PATH: defaultPathEnv() },
          timeout: 5 * 60 * 1000,
          maxBuffer: 64 * 1024 * 1024
        });

        updateInstallProgress({
          status: "installing",
          message: "Installing Markdown converter",
          current: 3,
          total: 4
        });
        await execFileAsync(pythonExecutablePath(), ["-m", "pip", "install", "--upgrade", "pip", "docling"], {
          env: { ...process.env, PATH: defaultPathEnv() },
          timeout: 20 * 60 * 1000,
          maxBuffer: 128 * 1024 * 1024
        });

        updateInstallProgress({
          status: "ready",
          message: "Markdown converter ready",
          current: 4,
          total: 4
        });
        return getMarkdownEngineAvailability();
      } catch (error) {
        updateInstallProgress({
          status: "error",
          message: error instanceof Error ? error.message : "Markdown converter installation failed.",
          current: 0,
          total: 4
        });
        throw error;
      } finally {
        installPromise = null;
      }
    })();

    return await installPromise;
  } finally {
    if (onProgress) {
      installProgressListeners.delete(onProgress);
    }
  }
}

async function readNewestMarkdownFile(directory: string) {
  const entries = await readdir(directory, { recursive: true });
  const markdownFiles: Array<{ path: string; mtimeMs: number }> = [];

  for (const entry of entries) {
    if (typeof entry !== "string" || !entry.endsWith(".md")) continue;
    const path = join(directory, entry);
    const fileStat = await stat(path);
    if (fileStat.isFile()) {
      markdownFiles.push({ path, mtimeMs: fileStat.mtimeMs });
    }
  }

  markdownFiles.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const markdownPath = markdownFiles[0]?.path;
  if (!markdownPath) return null;
  return readFile(markdownPath, "utf8");
}

function isExternalMarkdownUrl(url: string) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url);
}

function rewriteReferencedImagePaths(markdown: string, assetsDirName: string) {
  return markdown.replace(/(!\[[^\]]*]\()([^)]+)(\))/g, (match, prefix, rawUrl, suffix) => {
    const url = String(rawUrl).trim();
    if (!url || isExternalMarkdownUrl(url)) return match;
    return `${prefix}${assetsDirName}/${url.replace(/^\.\//, "")}${suffix}`;
  });
}

async function copyReferencedOutputAssets(outputDir: string, outputMarkdownPath: string) {
  const entries = await readdir(outputDir, { recursive: true });
  const targetBaseName = basename(outputMarkdownPath, extname(outputMarkdownPath));
  const assetsDirName = `${targetBaseName}-assets`;
  const assetsDir = join(dirname(outputMarkdownPath), assetsDirName);
  let copied = false;

  for (const entry of entries) {
    if (typeof entry !== "string" || entry.endsWith(".md")) continue;
    const sourcePath = join(outputDir, entry);
    const fileStat = await stat(sourcePath);
    if (!fileStat.isFile()) continue;

    const targetPath = join(assetsDir, entry);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    copied = true;
  }

  return copied ? assetsDirName : null;
}

export async function convertPdfWithDocling(
  bytes: Uint8Array | number[],
  settings: MarkdownExportSettings,
  outputMarkdownPath?: string
) {
  const doclingPath = doclingExecutablePath();
  if (!(await pathExists(doclingPath))) {
    throw new Error("Docling is not installed in the app-managed engine directory.");
  }

  const tempDir = await mkdtemp(join(tmpdir(), "markpdf-docling-"));
  const inputPath = join(tempDir, "input.pdf");

  try {
    await writeFile(inputPath, Buffer.from(bytes));
    const outputDir = join(tempDir, "output");
    const args = [
      inputPath,
      "--to",
      "md",
      "--output",
      outputDir,
      "--image-export-mode",
      outputMarkdownPath ? "referenced" : "embedded",
      "--tables",
      "--table-mode",
      "accurate"
    ];
    if (settings.defaultEngine === "docling-vlm-smoldocling") {
      args.push("--pipeline", "vlm", "--vlm-model", "smoldocling");
    }
    if (!settings.useOcrFallback) {
      args.push("--no-ocr");
    }

    const { stderr } = await execFileAsync(doclingPath, args, {
      env: { ...process.env, PATH: defaultPathEnv() },
      cwd: app.getPath("temp"),
      timeout: 10 * 60 * 1000,
      maxBuffer: 128 * 1024 * 1024
    });

    let markdown = (await readNewestMarkdownFile(outputDir))?.trim() ?? "";
    if (!markdown) {
      throw new Error(stderr.trim() || "Docling produced empty Markdown.");
    }

    if (outputMarkdownPath) {
      const assetsDirName = await copyReferencedOutputAssets(outputDir, outputMarkdownPath);
      if (assetsDirName) {
        markdown = rewriteReferencedImagePaths(markdown, assetsDirName);
      }
    }

    return {
      markdown: `${markdown}\n`,
      engineId: settings.defaultEngine === "docling-vlm-smoldocling" ? "docling-vlm-smoldocling" as const : "docling-managed" as const,
      warnings: stderr.trim() ? [stderr.trim()] : []
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
