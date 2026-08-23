import { resolveOcrDataDirectory } from "./trainedData.js";
import { ocrProfile } from "./ocrContract.js";
import type { OcrLineBox, OcrWordBox } from "./tableFromLines.js";

/** A recognised page: the engine's own text, which is authoritative, and the geometry it found. */
export interface RecognisedPage {
  text: string;
  lines: OcrLineBox[];
}

export interface TextRecogniser {
  recognise(image: Uint8Array): Promise<RecognisedPage>;
  close(): Promise<void>;
}

export interface RecogniserOptions {
  env?: NodeJS.ProcessEnv;
  onProgress?: (status: string, progress: number) => void;
}

/**
 * The options that make Tesseract run entirely from this installation.
 *
 * Exported so a test can assert them without starting an engine. Every field is here to close one
 * documented trap:
 *
 * - **`langPath`** is a local directory. Left unset, `worker-script/index.js:130` downloads the
 *   language data from jsdelivr on the first page, so an "offline" claim would be false.
 * - **`cacheMethod: "none"`** stops the write at `worker-script/index.js:181`, which otherwise
 *   puts `eng.traineddata` in `cachePath || '.'` — the current working directory, wherever the
 *   person happened to be standing when they ran the command.
 * - **`gzip: true`** matches the file that is actually bundled; the engine sniffs the magic bytes
 *   and decompresses it itself.
 */
export function tesseractOptions(env: NodeJS.ProcessEnv = process.env): {
  langPath: string;
  cacheMethod: "none";
  gzip: true;
} {
  return { langPath: resolveOcrDataDirectory(env), cacheMethod: "none", gzip: true };
}

export class OcrEngineError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OcrEngineError";
  }
}

function property(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  // `Reflect.get`, not an indexed access through a cast. `in` narrows the *presence* of the key
  // but not the object's index signature, so reading it with `[key]` needs an assertion — and
  // this is a third party's return value, which is exactly where an assertion is a claim nobody
  // checked. `Reflect.get` returns `unknown` and needs none.
  return Reflect.get(value, key);
}

/**
 * The recognised text, reconstructed from the engine's result rather than trusted.
 *
 * `worker.recognize` resolves to whatever the worker thread posted back, which crosses a
 * structured-clone boundary from a WebAssembly build. Reaching straight for `result.data.text`
 * would put `undefined` into an indexed chunk if that shape ever changed, and the page would be
 * stored as read when nothing had read it.
 */
export function textFromRecognitionResult(value: unknown): string {
  const text = property(property(value, "data"), "text");
  if (typeof text !== "string") {
    throw new OcrEngineError("The recognition engine returned no text field; the page cannot be treated as read.");
  }
  return text;
}

/**
 * The engine's parameters for the contract's index profile, which is the profile core reads
 * with.
 *
 * Exported so a test can assert them without starting an engine. The default page segmentation
 * is selected by the absence of an override — that is how the engine's own default is chosen,
 * and the measurement behind the contract says the default is the reading that keeps rows.
 */
export function indexRecognitionParameters(): Record<string, string> {
  const profile = ocrProfile("index");
  return { preserve_interword_spaces: profile.preserveInterwordSpaces ? "1" : "0" };
}

/** Resolve the installed engine enum through the name carried by the OCR contract. */
export function indexEngineValue<T>(engines: Readonly<{ LSTM_ONLY: T }>): T {
  return engines[ocrProfile("index").engine];
}

export interface ConfigurableTesseractWorker {
  setParameters(parameters: Readonly<Record<string, string>>): Promise<unknown>;
  terminate(): Promise<unknown>;
}

/** Apply the profile before exposing a worker, and release it if setup fails. */
export async function configureTesseractWorker<T extends ConfigurableTesseractWorker>(
  worker: T,
  parameters: Readonly<Record<string, string>>,
): Promise<T> {
  try {
    await worker.setParameters(parameters);
    return worker;
  } catch (configurationError) {
    try {
      await worker.terminate();
    } catch (terminationError) {
      throw new OcrEngineError("The recognition engine rejected its parameters and could not be terminated.", {
        cause: new AggregateError([configurationError, terminationError]),
      });
    }
    throw configurationError;
  }
}

/**
 * A recognised page, reconstructed from the engine's result rather than trusted.
 *
 * The text half keeps the strictness it has always had: a result with no text is not a page.
 * The geometry half is defensive in the other direction: a block, paragraph, line or word that
 * does not carry the expected shape is skipped, never fatal, because reconstruction is a pure
 * function of the lines and an empty list degrades to the flat text — the behaviour every page
 * had before geometry existed.
 */
export function pageFromRecognitionResult(value: unknown): RecognisedPage {
  const text = textFromRecognitionResult(value);
  const lines: OcrLineBox[] = [];

  const blocks = property(property(value, "data"), "blocks");
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      const paragraphs = property(block, "paragraphs");
      if (!Array.isArray(paragraphs)) continue;
      for (const paragraph of paragraphs) {
        const paragraphLines = property(paragraph, "lines");
        if (!Array.isArray(paragraphLines)) continue;
        for (const rawLine of paragraphLines) {
          const line = lineFromRecognition(rawLine);
          if (line !== null) lines.push(line);
        }
      }
    }
  }

  return { text, lines };
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function lineFromRecognition(value: unknown): OcrLineBox | null {
  if (typeof value !== "object" || value === null) return null;
  const text = property(value, "text");
  if (typeof text !== "string" || text.trim().length === 0) return null;

  const bbox = property(value, "bbox");
  const x0 = finiteNumber(property(bbox, "x0"));
  const y0 = finiteNumber(property(bbox, "y0"));
  const x1 = finiteNumber(property(bbox, "x1"));
  const y1 = finiteNumber(property(bbox, "y1"));
  if (x0 === null || y0 === null || x1 === null || y1 === null) return null;

  const words: OcrWordBox[] = [];
  const rawWords = property(value, "words");
  if (Array.isArray(rawWords)) {
    for (const rawWord of rawWords) {
      if (typeof rawWord !== "object" || rawWord === null) continue;
      const wordText = property(rawWord, "text");
      if (typeof wordText !== "string" || wordText.trim().length === 0) continue;
      const wordBox = property(rawWord, "bbox");
      const wordX0 = finiteNumber(property(wordBox, "x0"));
      const wordX1 = finiteNumber(property(wordBox, "x1"));
      if (wordX0 === null || wordX1 === null) continue;
      words.push({ text: wordText, x0: wordX0, x1: wordX1 });
    }
  }

  return { text, bbox: { x0, y0, x1, y1 }, words };
}

export interface RecognitionProgress {
  status: string;
  progress: number;
}

/**
 * One progress message, or nothing.
 *
 * Progress is decoration: a message that does not carry the two fields is dropped rather than
 * raised, because failing a document over a log line would be absurd.
 */
export function progressFromLoggerMessage(value: unknown): RecognitionProgress | null {
  const status = property(value, "status");
  const progress = property(value, "progress");
  if (typeof status !== "string") return null;
  if (typeof progress !== "number" || !Number.isFinite(progress)) return null;
  return { status, progress };
}

/**
 * Tesseract, configured to reach nothing outside this installation.
 *
 * **The language is named as a string, not passed as bytes.** The plan called for
 * `createWorker([{ code: "eng", data }])` so that no path handling was involved at all. That does
 * not work in the installed `tesseract.js` 7.0.0: `src/worker-script/index.js:101` reads
 * `_lang.code` when loading the file but `:238` reads `_lang.data` when naming the language to
 * initialise, so the engine is asked to open a data file named after the entire byte array and
 * reports `Error opening data file ./31,139,8,...`. Verified against the installed version. The
 * string form with a local `langPath` reaches the same file with none of that.
 *
 * The engine runs in a `worker_threads.Worker` (`src/worker/node/spawnWorker.js`), not a child
 * process, so it shares this process's module resolution and filesystem — including Electron's
 * archive-aware `fs` when the command runs from inside the packaged application.
 */
export interface WorkerOptions {
  langPath: string;
  cacheMethod: "none";
  gzip: true;
  errorHandler: (reason: unknown) => void;
  logger?: (message: unknown) => void;
}

/**
 * The complete option set handed to `createWorker`, assembled where it can be inspected.
 *
 * `errorHandler` is **required, not optional**. Without one, `createWorker.js:216-219` does
 * `throw Error(data)` from inside its own `worker.on("message")` handler whenever the worker
 * rejects a job — an uncaught exception on the main thread, which bypasses every exit code and
 * leaves a caller piping stdout with nothing at all. The job promise is rejected on the line
 * above, so this handler only has to exist for that rejection to be reachable normally.
 */
export function tesseractWorkerOptions(
  env: NodeJS.ProcessEnv,
  onProgress?: (status: string, progress: number) => void,
): WorkerOptions {
  return {
    ...tesseractOptions(env),
    errorHandler: () => undefined,
    ...(onProgress === undefined
      ? {}
      : {
          logger: (message: unknown) => {
            const progress = progressFromLoggerMessage(message);
            if (progress !== null) onProgress(progress.status, progress.progress);
          },
        }),
  };
}

function asOcrEngineError(error: unknown, what: string): OcrEngineError {
  if (error instanceof OcrEngineError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  return new OcrEngineError(`The recognition engine ${what}: ${reason}`, { cause: error });
}

export async function createTesseractRecogniser(options: RecogniserOptions = {}): Promise<TextRecogniser> {
  const { createWorker, OEM } = await import("tesseract.js");

  let worker: Awaited<ReturnType<typeof createWorker>>;
  try {
    // `OEM.LSTM_ONLY` matches the contract's profiles and matches the bundled `4.0.0_best_int`
    // data, which carries no legacy model.
    worker = await createWorker(
      "eng",
      indexEngineValue(OEM),
      tesseractWorkerOptions(options.env ?? process.env, options.onProgress),
    );
    // The index profile's parameters, which select the reading that keeps rows.
    worker = await configureTesseractWorker(worker, indexRecognitionParameters());
  } catch (error) {
    throw asOcrEngineError(error, "could not be started");
  }

  // A worker is a live thread. Anything that goes wrong between here and handing it back would
  // otherwise leave it running for the life of the process.
  try {
    return {
      async recognise(image) {
        try {
          // `blocks: true` is what makes word geometry cross the worker boundary; without it the
          // engine returns text alone and reconstruction has nothing to cluster.
          return pageFromRecognitionResult(
            await worker.recognize(Buffer.from(image), {}, { blocks: true, text: true }),
          );
        } catch (error) {
          throw asOcrEngineError(error, "could not read a page");
        }
      },
      async close() {
        await worker.terminate();
      },
    };
  } catch (error) {
    await worker.terminate();
    throw error;
  }
}
