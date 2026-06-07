import { app } from "electron";
import { access, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type MarkdownEngineId = "builtin-text" | "docling-managed";
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
}

export interface MarkdownStoreSchema {
  markdownExport: MarkdownExportSettings;
}

export const defaultMarkdownExportSettings: MarkdownExportSettings = {
  defaultEngine: "docling-managed",
  exportMode: "readable",
  includePageMarkers: true,
  useOcrFallback: true,
  includeAnnotations: true,
  aiCleanup: false
};

export function normalizeMarkdownExportSettings(settings?: Partial<MarkdownExportSettings>): MarkdownExportSettings {
  return {
    ...defaultMarkdownExportSettings,
    ...settings,
    defaultEngine: "docling-managed"
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
    } catch (error) {
      engines.push({
        id: "docling-managed",
        name: "Docling",
        available: false,
        error: error instanceof Error ? error.message : "The managed Docling engine could not be started."
      });
    }
  } else {
    engines.push({
      id: "docling-managed",
      name: "Docling",
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
  if (!markdownPath) return "";
  return readFile(markdownPath, "utf8");
}

export async function convertPdfWithDocling(bytes: Uint8Array | number[], settings: MarkdownExportSettings) {
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
      "placeholder",
      "--table-mode",
      "accurate"
    ];
    if (!settings.useOcrFallback) {
      args.push("--no-ocr");
    }

    const { stderr } = await execFileAsync(doclingPath, args, {
      env: { ...process.env, PATH: defaultPathEnv() },
      cwd: app.getPath("temp"),
      timeout: 10 * 60 * 1000,
      maxBuffer: 128 * 1024 * 1024
    });

    const markdown = (await readNewestMarkdownFile(outputDir)).trim();
    if (!markdown) {
      throw new Error(stderr.trim() || "Docling produced empty Markdown.");
    }

    return {
      markdown: `${markdown}\n`,
      engineId: "docling-managed" as const,
      warnings: stderr.trim() ? [stderr.trim()] : []
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
