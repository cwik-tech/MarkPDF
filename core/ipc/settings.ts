import {
  curatedEmbeddingModels,
  defaultSemanticScoreThreshold,
  recommendedEmbeddingModelId,
  type SemanticChunkingProfile,
} from "../models.js";
import { SemanticRequestError } from "./requests.js";

export type { SemanticChunkingProfile };

export interface SemanticSearchSettings {
  enabled: boolean;
  activeModelId: string;
  chunkingProfile: SemanticChunkingProfile;
  minSemanticScore: number;
  downloadedModelIds: string[];
}

export const defaultSemanticSearchSettings: SemanticSearchSettings = {
  enabled: true,
  activeModelId: recommendedEmbeddingModelId,
  chunkingProfile: "balanced",
  minSemanticScore: defaultSemanticScoreThreshold,
  downloadedModelIds: [],
};

const MIN_SCORE = 0;
const MAX_SCORE = 0.95;

function isCurated(value: unknown): value is string {
  return typeof value === "string" && curatedEmbeddingModels.some((model) => model.id === value);
}

function isChunkingProfile(value: unknown): value is SemanticChunkingProfile {
  return value === "precise" || value === "balanced" || value === "contextual";
}

/** A renderer-supplied model id. Rejected outright, never repaired. */
export function parseCuratedModelId(value: unknown): string {
  if (!isCurated(value)) {
    throw new SemanticRequestError(`"${String(value)}" is not a curated embedding model.`);
  }
  return value;
}

/**
 * Read persisted settings, which are external input.
 *
 * The store on disk can be hand-edited, written by an older build, or corrupted. Anything
 * unrecognised falls back to the default rather than being carried forward: an invalid
 * `activeModelId` in particular would otherwise reach `getCuratedEmbeddingModel`, which
 * silently substitutes the default, so the bad value would persist while appearing to work.
 */
export function parseSemanticSettings(raw: unknown): SemanticSearchSettings {
  const record: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const score = record.minSemanticScore;
  const minSemanticScore =
    typeof score === "number" && Number.isFinite(score)
      ? Math.min(MAX_SCORE, Math.max(MIN_SCORE, score))
      : defaultSemanticSearchSettings.minSemanticScore;

  const downloaded = Array.isArray(record.downloadedModelIds) ? record.downloadedModelIds : [];

  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : defaultSemanticSearchSettings.enabled,
    activeModelId: isCurated(record.activeModelId)
      ? record.activeModelId
      : defaultSemanticSearchSettings.activeModelId,
    chunkingProfile: isChunkingProfile(record.chunkingProfile)
      ? record.chunkingProfile
      : defaultSemanticSearchSettings.chunkingProfile,
    minSemanticScore,
    downloadedModelIds: downloaded.filter(isCurated),
  };
}

export type SemanticSettingsPatch = Partial<SemanticSearchSettings>;

const PATCHABLE_FIELDS: ReadonlySet<string> = new Set([
  "enabled",
  "activeModelId",
  "chunkingProfile",
  "minSemanticScore",
  "downloadedModelIds",
]);

/**
 * A patch arriving over IPC.
 *
 * Unlike persisted values, an unrecognised field here is rejected rather than repaired:
 * quietly dropping it would leave the interface showing a selection that never took effect.
 */
export function parseSemanticSettingsPatch(raw: unknown): SemanticSettingsPatch {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SemanticRequestError("settings patch must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const patch: SemanticSettingsPatch = {};

  if (record.enabled !== undefined) {
    if (typeof record.enabled !== "boolean") throw new SemanticRequestError("enabled must be a boolean.");
    patch.enabled = record.enabled;
  }
  if (record.activeModelId !== undefined) {
    patch.activeModelId = parseCuratedModelId(record.activeModelId);
  }
  if (record.chunkingProfile !== undefined) {
    if (!isChunkingProfile(record.chunkingProfile)) {
      throw new SemanticRequestError("chunkingProfile must be precise, balanced or contextual.");
    }
    patch.chunkingProfile = record.chunkingProfile;
  }
  if (record.minSemanticScore !== undefined) {
    const value = record.minSemanticScore;
    if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_SCORE || value > MAX_SCORE) {
      throw new SemanticRequestError(`minSemanticScore must be between ${MIN_SCORE} and ${MAX_SCORE}.`);
    }
    patch.minSemanticScore = value;
  }
  if (record.downloadedModelIds !== undefined) {
    if (!Array.isArray(record.downloadedModelIds)) {
      throw new SemanticRequestError("downloadedModelIds must be an array.");
    }
    patch.downloadedModelIds = record.downloadedModelIds.map(parseCuratedModelId);
  }

  // Checked last, so a recognised field with a bad value still gets its own specific message.
  const unknown = Object.keys(record).filter((key) => !PATCHABLE_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new SemanticRequestError(`settings patch has unknown field(s): ${unknown.join(", ")}.`);
  }
  return patch;
}
