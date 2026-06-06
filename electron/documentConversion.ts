import { app } from "electron";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  defaultEngine: "builtin-text",
  exportMode: "readable",
  includePageMarkers: true,
  useOcrFallback: true,
  includeAnnotations: true,
  aiCleanup: false
};

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
  throw new Error("Python 3 was not found. A bundled Python runtime is needed for fully offline Docling installs.");
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
      error: "Not installed. Install it from Markdown settings."
    });
  }

  return engines;
}

export async function installManagedDocling() {
  const doclingPath = doclingExecutablePath();
  if (await pathExists(doclingPath)) {
    return getMarkdownEngineAvailability();
  }

  const pythonCommand = await findPythonCommand();
  const venvArgs = process.platform === "win32" && pythonCommand === "py"
    ? ["-3", "-m", "venv", doclingVenvDir()]
    : ["-m", "venv", doclingVenvDir()];

  await execFileAsync(pythonCommand, venvArgs, {
    env: { ...process.env, PATH: defaultPathEnv() },
    timeout: 5 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024
  });

  await execFileAsync(pythonExecutablePath(), ["-m", "pip", "install", "--upgrade", "pip", "docling"], {
    env: { ...process.env, PATH: defaultPathEnv() },
    timeout: 20 * 60 * 1000,
    maxBuffer: 128 * 1024 * 1024
  });

  return getMarkdownEngineAvailability();
}

export async function convertPdfWithDocling(bytes: number[], settings: MarkdownExportSettings) {
  const doclingPath = doclingExecutablePath();
  if (!(await pathExists(doclingPath))) {
    throw new Error("Docling is not installed in the app-managed engine directory.");
  }

  const tempDir = await mkdtemp(join(tmpdir(), "open-pdf-reader-docling-"));
  const inputPath = join(tempDir, "input.pdf");

  try {
    await writeFile(inputPath, Buffer.from(bytes));
    const args = [inputPath, "--format", "markdown"];
    if (!settings.useOcrFallback) {
      args.push("--no-ocr");
    }

    const { stdout, stderr } = await execFileAsync(doclingPath, args, {
      env: { ...process.env, PATH: defaultPathEnv() },
      cwd: app.getPath("temp"),
      timeout: 10 * 60 * 1000,
      maxBuffer: 128 * 1024 * 1024
    });

    const markdown = stdout.trim();
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
