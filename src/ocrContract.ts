/**
 * The renderer's copy of the OCR contract.
 *
 * The renderer must not import core, so the contract it reads with is mirrored here and
 * `core/modelParity.test.ts` holds the two spellings together. The window's overlay reads with
 * this profile; the index reads with the `index` profile declared in core, and the two are
 * different on purpose — the measurement that decided each is recorded beside the core
 * contract.
 */

export const OCR_CONTRACT_VERSION = 2;

export const RENDERER_OCR_PROFILE = {
  engine: "LSTM_ONLY",
  pageSegmentation: "SPARSE_TEXT",
  preserveInterwordSpaces: true,
  renderScale: 2,
} as const;

/** Resolve the installed engine enum through the name carried by the mirrored profile. */
export function overlayEngineValue<T>(engines: Readonly<{ LSTM_ONLY: T }>): T {
  return engines[RENDERER_OCR_PROFILE.engine];
}

/** Translate the mirrored profile to the parameter names accepted by Tesseract.js. */
export function overlayRecognitionParameters<T>(pageSegmentationModes: Readonly<{ SPARSE_TEXT: T }>): {
  tessedit_pageseg_mode: T;
  preserve_interword_spaces: string;
} {
  return {
    tessedit_pageseg_mode: pageSegmentationModes[RENDERER_OCR_PROFILE.pageSegmentation],
    preserve_interword_spaces: RENDERER_OCR_PROFILE.preserveInterwordSpaces ? "1" : "0",
  };
}
