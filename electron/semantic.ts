import { app } from "electron";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type SemanticChunkingProfile = "precise" | "balanced" | "contextual";

export interface SemanticSearchSettings {
  enabled: boolean;
  activeModelId: string;
  chunkingProfile: SemanticChunkingProfile;
  minSemanticScore: number;
  downloadedModelIds: string[];
}

export interface SemanticStoreSchema {
  semanticSearch: SemanticSearchSettings;
}

export const defaultSemanticSearchSettings: SemanticSearchSettings = {
  enabled: true,
  activeModelId: "Xenova/bge-small-en-v1.5",
  chunkingProfile: "balanced",
  minSemanticScore: 0.3,
  downloadedModelIds: []
};

export function normalizeSemanticSearchSettings(settings: Partial<SemanticSearchSettings> = {}): SemanticSearchSettings {
  const minSemanticScore =
    typeof settings.minSemanticScore === "number" && Number.isFinite(settings.minSemanticScore)
      ? Math.min(0.95, Math.max(0, settings.minSemanticScore))
      : defaultSemanticSearchSettings.minSemanticScore;

  return {
    ...defaultSemanticSearchSettings,
    ...settings,
    minSemanticScore,
    downloadedModelIds: settings.downloadedModelIds ?? defaultSemanticSearchSettings.downloadedModelIds
  };
}

function semanticDbPath() {
  return join(app.getPath("userData"), "semantic-search", "semantic-index.sqlite");
}

export async function loadSemanticDatabase() {
  try {
    const data = await readFile(semanticDbPath());
    return Array.from(data);
  } catch {
    return null;
  }
}

export async function saveSemanticDatabase(bytes: Uint8Array | number[]) {
  const dbPath = semanticDbPath();
  await mkdir(dirname(dbPath), { recursive: true });
  await writeFile(dbPath, Buffer.from(bytes));
}

export async function clearSemanticDatabase() {
  await rm(semanticDbPath(), { force: true });
}

export async function getSemanticDatabaseInfo() {
  try {
    const dbStat = await stat(semanticDbPath());
    return { sizeBytes: dbStat.size };
  } catch {
    return { sizeBytes: 0 };
  }
}
