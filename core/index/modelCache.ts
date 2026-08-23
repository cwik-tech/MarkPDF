import { readdirSync } from "node:fs";
import { join } from "node:path";
import { modelCacheDir } from "../paths.js";

function containsAnyFile(directory: string): boolean {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    // Missing or unreadable. Either way this is not a usable cache, and the caller's remedy is
    // the same: download it. Reporting absence is more useful here than raising.
    return false;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (containsAnyFile(join(directory, entry.name))) return true;
    } else if (entry.isFile()) {
      return true;
    }
  }
  return false;
}

/**
 * Whether an embedding model's weights are on disk.
 *
 * Persisted settings record which models have been downloaded, but that record can be wrong:
 * the cache may have been cleared, the data directory moved, or a download interrupted after
 * creating its folder. Trusting it means the interface reports a model as ready and the next
 * index quietly starts a 133 MB fetch with no progress shown anywhere.
 *
 * The limit of this check, stated rather than implied: it proves files exist, not that they are
 * complete or valid. A truncated download still surfaces as a load error — this only stops the
 * far more common case of a claim with nothing behind it at all.
 */
export function isModelCached(dataDir: string, modelId: string): boolean {
  return containsAnyFile(join(modelCacheDir(dataDir), modelId));
}

/** The claimed models that are genuinely present, in the order they were claimed. */
export function filterCachedModels(dataDir: string, modelIds: readonly string[]): string[] {
  return modelIds.filter((modelId) => isModelCached(dataDir, modelId));
}
