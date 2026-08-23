import { resolveOcrDataDirectory } from "./trainedData.js";

export interface TextRecogniser {
  recognise(image: Uint8Array): Promise<string>;
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
    // `OEM.LSTM_ONLY` matches the reader (`src/pdf/ocr.ts:57`) and matches the bundled
    // `4.0.0_best_int` data, which carries no legacy model.
    worker = await createWorker("eng", OEM.LSTM_ONLY, tesseractWorkerOptions(options.env ?? process.env, options.onProgress));
  } catch (error) {
    throw asOcrEngineError(error, "could not be started");
  }

  // A worker is a live thread. Anything that goes wrong between here and handing it back would
  // otherwise leave it running for the life of the process.
  try {
    return {
      async recognise(image) {
        try {
          return textFromRecognitionResult(await worker.recognize(Buffer.from(image)));
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
