import { app } from "electron";
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

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
  includeImageDescriptions: boolean;
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
  includeImageDescriptions: true,
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
  return readNewestTextFile(directory, ".md");
}

async function readNewestJsonFile(directory: string) {
  return readNewestTextFile(directory, ".json");
}

async function readNewestTextFile(directory: string, extension: string) {
  const entries = await readdir(directory, { recursive: true });
  const outputFiles: Array<{ path: string; mtimeMs: number }> = [];

  for (const entry of entries) {
    if (typeof entry !== "string" || extname(entry).toLowerCase() !== extension) continue;
    const path = join(directory, entry);
    const fileStat = await stat(path);
    if (fileStat.isFile()) {
      outputFiles.push({ path, mtimeMs: fileStat.mtimeMs });
    }
  }

  outputFiles.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const outputPath = outputFiles[0]?.path;
  if (!outputPath) return null;
  return readFile(outputPath, "utf8");
}

function isExternalMarkdownUrl(url: string) {
  return /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(url) || url.startsWith("//");
}

function cleanMarkdownUrl(url: string) {
  const trimmed = url.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

function pathIsInsideDirectory(path: string, directory: string) {
  const relativePath = relative(normalize(directory), normalize(path));
  return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function normalizeMarkdownAssetPath(path: string) {
  return path.replace(/^\.\//, "").split(/[\\/]+/).join("/");
}

function markdownAssetPathForUrl(rawUrl: string, assetsDirName: string, outputDir: string) {
  const url = cleanMarkdownUrl(rawUrl);
  if (!url) return null;

  if (url.startsWith("file://")) {
    try {
      const filePath = normalize(fileURLToPath(url));
      return pathIsInsideDirectory(filePath, outputDir)
        ? `${assetsDirName}/${normalizeMarkdownAssetPath(relative(outputDir, filePath))}`
        : null;
    } catch {
      return null;
    }
  }

  if (isAbsolute(url)) {
    const filePath = normalize(url);
    return pathIsInsideDirectory(filePath, outputDir)
      ? `${assetsDirName}/${normalizeMarkdownAssetPath(relative(outputDir, filePath))}`
      : null;
  }

  if (isExternalMarkdownUrl(url)) return null;
  return `${assetsDirName}/${normalizeMarkdownAssetPath(url)}`;
}

function rewriteReferencedImagePaths(markdown: string, assetsDirName: string, outputDir: string) {
  return markdown.replace(/(!\[[^\]]*]\()([^)]+)(\))/g, (match, prefix, rawUrl, suffix) => {
    const url = markdownAssetPathForUrl(String(rawUrl), assetsDirName, outputDir);
    return url ? `${prefix}${url}${suffix}` : match;
  });
}

const imageAssetExtensions = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp"
]);

function normalizeImageDescription(text: unknown) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function descriptionWords(text: string) {
  return text.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function hasRepetitiveDescriptionLoop(text: string) {
  const segments = text
    .split(/[;,]+/)
    .map((segment) => normalizeImageDescription(segment).toLocaleLowerCase())
    .filter((segment) => segment.length > 2);
  if (segments.length < 6) return false;

  const counts = new Map<string, number>();
  for (const segment of segments) {
    counts.set(segment, (counts.get(segment) ?? 0) + 1);
  }

  const maxCount = Math.max(...counts.values());
  return maxCount >= 3 || counts.size / segments.length < 0.55;
}

function cleanImageDescription(text: string) {
  return text
    .replace(/^\s*(?:\*\*)?image description:(?:\*\*)?\s*/i, "")
    .replace(/^\s*\[description]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function usableImageDescription(text: string) {
  const description = cleanImageDescription(text);
  const words = descriptionWords(description);
  if (description.length < 24 || words.length < 4) return "";
  if (/^(?:in|the|a|an|image|the image|an image)$/i.test(description)) return "";
  if (hasRepetitiveDescriptionLoop(description)) return "";
  return description;
}

interface PictureDescription {
  raw: string;
  text: string;
}

function pictureDescriptionFromJsonPicture(picture: unknown) {
  if (!picture || typeof picture !== "object") return { raw: "", text: "" };
  const record = picture as {
    meta?: { description?: { text?: unknown } };
    annotations?: Array<{ kind?: unknown; text?: unknown }>;
  };

  const rawDescription = normalizeImageDescription(record.meta?.description?.text);
  if (rawDescription) {
    return { raw: rawDescription, text: usableImageDescription(rawDescription) };
  }

  const annotation = record.annotations?.find((item) => item.kind === "description");
  const annotationDescription = normalizeImageDescription(annotation?.text);
  return {
    raw: annotationDescription,
    text: usableImageDescription(annotationDescription)
  };
}

function extractPictureDescriptions(jsonText: string | null): PictureDescription[] {
  if (!jsonText) return [];

  try {
    const parsed = JSON.parse(jsonText) as { pictures?: unknown[] };
    if (!Array.isArray(parsed.pictures)) return [];
    return parsed.pictures.map(pictureDescriptionFromJsonPicture);
  } catch {
    return [];
  }
}

function countMarkdownImages(markdown: string) {
  return [...markdown.matchAll(/!\[[^\]]*]\([^)]+\)/g)].length;
}

function normalizeDescriptionBlock(text: string) {
  return cleanImageDescription(text);
}

function previousBlockMatchesDescription(lines: string[], description: string) {
  const previousText = lines.join(" ");
  return normalizeDescriptionBlock(previousText) === normalizeImageDescription(description);
}

function removePreviousDescriptionBlock(lines: string[], description: string) {
  let blockEnd = lines.length - 1;
  while (blockEnd >= 0 && !lines[blockEnd].trim()) blockEnd -= 1;
  if (blockEnd < 0) return;

  let blockStart = blockEnd;
  while (blockStart > 0 && lines[blockStart - 1].trim()) blockStart -= 1;

  if (previousBlockMatchesDescription(lines.slice(blockStart, blockEnd + 1), description)) {
    lines.splice(blockStart);
  }
}

function insertImageDescriptionsBelowImages(markdown: string, descriptions: PictureDescription[]) {
  if (descriptions.length === 0) return markdown;

  const outputLines: string[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let imageIndex = 0;

  for (const line of lines) {
    if (!/!\[[^\]]*]\([^)]+\)/.test(line)) {
      outputLines.push(line);
      continue;
    }

    const description = descriptions[imageIndex];
    imageIndex += 1;

    if (!description?.raw && !description?.text) {
      outputLines.push(line);
      continue;
    }

    if (description.raw) {
      removePreviousDescriptionBlock(outputLines, description.raw);
    }
    outputLines.push(line);
    if (description.text) {
      outputLines.push("", `**Image description:** ${description.text}`);
    }
  }

  return outputLines.join("\n");
}

async function copyReferencedOutputAssets(outputDir: string, outputMarkdownPath: string) {
  const entries = await readdir(outputDir, { recursive: true });
  const targetBaseName = basename(outputMarkdownPath, extname(outputMarkdownPath));
  const assetsDirName = `${targetBaseName}-assets`;
  const assetsDir = join(dirname(outputMarkdownPath), assetsDirName);
  let copied = false;

  for (const entry of entries) {
    if (typeof entry !== "string" || !imageAssetExtensions.has(extname(entry).toLowerCase())) continue;
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
    if (settings.includeImageDescriptions) {
      args.push("--to", "json", "--enrich-picture-description");
    }
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

    const warnings: string[] = [];
    if (settings.includeImageDescriptions) {
      const imageCount = countMarkdownImages(markdown);
      const descriptions = extractPictureDescriptions(await readNewestJsonFile(outputDir));
      const usableDescriptionCount = descriptions.filter((description) => description.text).length;
      if (descriptions.length > 0) {
        markdown = insertImageDescriptionsBelowImages(markdown, descriptions);
      }
      if (imageCount > usableDescriptionCount) {
        warnings.push(
          usableDescriptionCount === 0
            ? "Image descriptions were enabled, but Docling did not return usable picture descriptions."
            : "Some generated image descriptions were skipped because they were too short or repetitive."
        );
      }
    }

    if (outputMarkdownPath) {
      const assetsDirName = await copyReferencedOutputAssets(outputDir, outputMarkdownPath);
      if (assetsDirName) {
        markdown = rewriteReferencedImagePaths(markdown, assetsDirName, outputDir);
      }
    }

    return {
      markdown: `${markdown}\n`,
      engineId: settings.defaultEngine === "docling-vlm-smoldocling" ? "docling-vlm-smoldocling" as const : "docling-managed" as const,
      warnings: [...warnings, ...(stderr.trim() ? [stderr.trim()] : [])]
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
