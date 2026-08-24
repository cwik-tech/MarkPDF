import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rasterisePdfPages, type PageImage, type RasteriseOptions } from "./rasterisePages.js";

/**
 * A guarded record of which pages were ever rendered, for tests that must say a document was
 * read without rasterising pages it did not have to.
 *
 * The guard mirrors the deterministic embedder's, for the same reason: the failure being
 * prevented is a shipped surface quietly writing test records into a real user's data directory.
 * All three conditions must hold — the process is not packaged, the flag equals the exact
 * opt-in token, and a test data directory is set. The record file is written inside that
 * directory and nowhere else: the environment is external input, and a path taken from it
 * would be a place an untrusted value could point.
 */
export const RASTERISATION_RECORD_TOKEN = "record";

export interface RasterisationRecordInput {
  isPackaged: boolean;
  env: {
    MARKPDF_E2E_RASTERISATION_RECORD?: string | undefined;
    MARKPDF_TEST_USER_DATA?: string | undefined;
  };
}

export function shouldRecordRasterisation(input: RasterisationRecordInput): boolean {
  if (input.isPackaged) return false;
  if (input.env.MARKPDF_E2E_RASTERISATION_RECORD !== RASTERISATION_RECORD_TOKEN) return false;
  const testUserData = input.env.MARKPDF_TEST_USER_DATA;
  if (typeof testUserData !== "string" || testUserData.length === 0) return false;
  return true;
}

export function rasterisationRecordPath(dataDir: string): string {
  return join(dataDir, "rasterised-pages.json");
}

/** The pages recorded so far, ascending and deduplicated. Anything unreadable is no pages. */
export function readRasterisationRecord(dataDir: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(rasterisationRecordPath(dataDir), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry))
    .sort((a, b) => a - b);
}

function writeRasterisationRecord(dataDir: string, pages: readonly number[]): void {
  writeFileSync(rasterisationRecordPath(dataDir), `${JSON.stringify(pages)}\n`, "utf8");
}

/**
 * A rasteriser that remembers every page it rendered, wrapping the real one.
 *
 * The record is merged and rewritten after each pass, so a journey reading it after the run
 * sees every page any pass rendered. A write that fails does not replace the render's result:
 * the record is a diagnostic, and losing it must not lose the reading.
 */
export function recordingRasteriser(
  dataDir: string,
): (bytes: Uint8Array, options: RasteriseOptions) => Promise<PageImage[]> {
  return async (bytes, options) => {
    const images = await rasterisePdfPages(bytes, options);
    try {
      const merged = [...new Set([...readRasterisationRecord(dataDir), ...images.map((image) => image.page)])].sort(
        (a, b) => a - b,
      );
      writeRasterisationRecord(dataDir, merged);
    } catch {
      // Diagnostic only — see above.
    }
    return images;
  };
}
