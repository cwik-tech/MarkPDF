/**
 * One versioned contract for every way this program reads a page of a scan.
 *
 * Two named profiles, because the measurement behind them found that one configuration cannot
 * serve both consumers. Measured against the installed Node engine on a rendered financial
 * table:
 *
 * - The engine's **default page segmentation** returns the table one row per line —
 *   `Sales & Marketing 4110 4620 5170 5890` — which is the shape the index needs: rows kept
 *   whole, word positions recoverable, columns reconstructible.
 * - **`SPARSE_TEXT`** returns every cell as its own paragraph, which destroys row structure —
 *   but it is the shape the window's highlight overlay is drawn from, because it boxes each
 *   cell directly (`src/App.tsx`, the overlay's line boxes).
 * - 144 dpi and 200 dpi produced byte-identical text, so the two render resolutions differ in
 *   cost, not in reading. Each profile states the resolution its consumer already uses.
 *
 * Both profiles live in this one versioned module so a change to either is a change to
 * `OCR_CONTRACT_VERSION`. The renderer cannot import core, so it mirrors this contract in
 * `src/ocrContract.ts` and `core/modelParity.test.ts` holds the two spellings together.
 */

export type OcrProfileName = "index" | "overlay";

export interface IndexOcrProfile {
  engine: "LSTM_ONLY";
  pageSegmentation: "default";
  preserveInterwordSpaces: boolean;
  /** Rasterisation resolution for indexing. */
  dpi: number;
}

export interface OverlayOcrProfile {
  engine: "LSTM_ONLY";
  pageSegmentation: "SPARSE_TEXT";
  preserveInterwordSpaces: boolean;
  /** Canvas scale relative to the page's points. */
  renderScale: number;
}

export type OcrProfile = IndexOcrProfile | OverlayOcrProfile;

/** Version 1 was the unversioned renderer-owned OCR path. */
export const OCR_CONTRACT_VERSION = 2;

export function ocrProfile(profile: "index"): IndexOcrProfile;
export function ocrProfile(profile: "overlay"): OverlayOcrProfile;
export function ocrProfile(profile: OcrProfileName): OcrProfile {
  if (profile === "index") {
    return { engine: "LSTM_ONLY", pageSegmentation: "default", preserveInterwordSpaces: true, dpi: 200 };
  }
  return { engine: "LSTM_ONLY", pageSegmentation: "SPARSE_TEXT", preserveInterwordSpaces: true, renderScale: 2 };
}
