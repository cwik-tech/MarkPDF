import { app } from "electron";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type SemanticChunkingProfile = "precise" | "balanced" | "contextual";

export interface SemanticSearchSettings {
  enabled: boolean;
  activeModelId: string;
  chunkingProfile: SemanticChunkingProfile;
  downloadedModelIds: string[];
}

export interface SemanticStoreSchema {
  semanticSearch: SemanticSearchSettings;
}

export const defaultSemanticSearchSettings: SemanticSearchSettings = {
  enabled: true,
  activeModelId: "BAAI/bge-small-en-v1.5",
  chunkingProfile: "balanced",
  downloadedModelIds: []
};

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

export async function saveSemanticDatabase(bytes: number[]) {
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
