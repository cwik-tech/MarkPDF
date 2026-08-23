import { existsSync, openSync, readSync, closeSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export class OcrDataUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OcrDataUnavailableError";
  }
}

/** The file the OCR engine looks for inside the directory it is given. */
export const TRAINED_DATA_FILE = "eng.traineddata.gz";

/**
 * Is this file gzip at all?
 *
 * Checked here rather than left to the engine, because the engine does not fail cleanly. Given a
 * file that is not the language data, `tesseract.js` 7.0.0 rejects the job and then dereferences
 * an already-deleted promise in its own `worker.on("message")` handler
 * (`src/createWorker.js:208`), which is an uncaught exception in an event callback — no exit code,
 * no output, a stack trace. Two magic bytes are enough to keep that from ever being reached.
 *
 * It is not a claim that the data is *valid*, only that it is the kind of file it should be. A
 * gzip stream of the wrong contents would still reach the engine.
 */
function looksLikeGzip(path: string): boolean {
  let handle: number;
  try {
    handle = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    const header = Buffer.alloc(2);
    const read = readSync(handle, header, 0, 2, 0);
    return read === 2 && header[0] === 0x1f && header[1] === 0x8b;
  } finally {
    closeSync(handle);
  }
}

function requireUsableData(directory: string, describe: () => string): string {
  const file = join(directory, TRAINED_DATA_FILE);
  if (!existsSync(file)) throw new OcrDataUnavailableError(`The OCR language data is missing: ${describe()}.`);
  if (!looksLikeGzip(file)) {
    throw new OcrDataUnavailableError(`The OCR language data at ${file} is not readable as compressed language data.`);
  }
  return directory;
}

/**
 * The directory holding the bundled English language data.
 *
 * **`4.0.0_best_int`, not `4.0.0`.** The integerised model is 2.8 MB against 10 MB and is the
 * only one the LSTM-only engine needs, which is the engine the reader already uses
 * (`src/pdf/ocr.ts:57`). Matching it means a scan indexed from the command line is recognised the
 * same way as one indexed from the application.
 *
 * `MARKPDF_OCR_DATA_DIR` overrides it, for an installation that keeps the data elsewhere.
 *
 * Fails closed with a named error rather than letting the engine fall back to its default, which
 * is a CDN: an installation missing this file should say so, not quietly start downloading.
 */
export function resolveOcrDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MARKPDF_OCR_DATA_DIR;
  if (override !== undefined && override.length > 0) {
    return requireUsableData(override, () => `MARKPDF_OCR_DATA_DIR is set to ${override}, which has no ${TRAINED_DATA_FILE}`);
  }

  let bundled: string;
  try {
    bundled = dirname(require.resolve(`@tesseract.js-data/eng/4.0.0_best_int/${TRAINED_DATA_FILE}`));
  } catch (error) {
    throw new OcrDataUnavailableError(
      `The OCR language data is missing from this installation (@tesseract.js-data/eng/4.0.0_best_int/${TRAINED_DATA_FILE}).`,
      { cause: error },
    );
  }
  return requireUsableData(bundled, () => `this installation has no ${TRAINED_DATA_FILE}`);
}
