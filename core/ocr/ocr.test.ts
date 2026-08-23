import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { ocrPages } from "./ocrPages.js";
import { rasterisePdfPages, RasterisationCancelled } from "./rasterisePages.js";
import { OCR_CONTRACT_VERSION, ocrProfile } from "./ocrContract.js";
import {
  configureTesseractWorker,
  OcrEngineError,
  indexEngineValue,
  indexRecognitionParameters,
  pageFromRecognitionResult,
  progressFromLoggerMessage,
  tesseractOptions,
  tesseractWorkerOptions,
  textFromRecognitionResult,
} from "./tesseractEngine.js";
import { OCR_EXTRACTION_VERSION } from "../models.js";
import { OcrDataUnavailableError, resolveOcrDataDirectory, TRAINED_DATA_FILE } from "./trainedData.js";
import type { TextRecogniser } from "./tesseractEngine.js";
import {
  EXPECTED_PAGE_10_MARKDOWN,
  RECORDED_PAGE_10_RESULT,
} from "./recordedRecognition.test-support.js";

/**
 * Reading a page that is only pixels.
 *
 * The recogniser itself is replaced here, because starting a real one costs seconds and proves
 * something the offline journey already proves end to end. What these check is the part around
 * it: which pages get rendered, at what size, what happens to a page that recognises to nothing,
 * and the configuration that keeps the engine away from the network and out of the user's
 * working directory.
 */

let workDir: string;

async function buildTwoPagePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const label of ["First page", "Second page"]) {
    const page = pdf.addPage([612, 792]);
    page.drawText(label, { x: 60, y: 700, size: 24, font });
  }
  return await pdf.save();
}

function recogniser(answers: Record<number, string>, calls: number[] = []): TextRecogniser {
  let position = 0;
  return {
    async recognise() {
      position += 1;
      calls.push(position);
      return { text: answers[position] ?? "", lines: [] };
    },
    async close() {
      // Nothing to release in the stand-in; the real one terminates a worker thread.
    },
  };
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "markpdf-ocr-"));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("rendering pages to images", () => {
  it("renders exactly the pages it was asked for, and names them the way the rest of the code does", async () => {
    const images = await rasterisePdfPages(await buildTwoPagePdf(), { pages: [2] });

    expect(images).toHaveLength(1);
    expect(images[0]?.page).toBe(2);
  }, 60_000);

  it("produces a PNG", async () => {
    const images = await rasterisePdfPages(await buildTwoPagePdf(), { pages: [1] });
    const magic = [...(images[0]?.image.slice(0, 4) ?? [])];

    expect(magic).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 60_000);

  it("renders larger at a higher resolution, because that is what the recogniser needs", async () => {
    const bytes = await buildTwoPagePdf();

    const low = await rasterisePdfPages(bytes, { pages: [1], dpi: 72 });
    const high = await rasterisePdfPages(bytes, { pages: [1], dpi: 200 });

    expect(high[0]!.width).toBeGreaterThan(low[0]!.width);
  }, 60_000);

  it("ignores a page the document does not have rather than failing the whole render", async () => {
    const images = await rasterisePdfPages(await buildTwoPagePdf(), { pages: [1, 99] });

    expect(images.map((image) => image.page)).toEqual([1]);
  }, 60_000);

  it("does nothing at all when no page was asked for", async () => {
    expect(await rasterisePdfPages(await buildTwoPagePdf(), { pages: [] })).toEqual([]);
  });

  it("stops when cancelled rather than rendering the rest", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(rasterisePdfPages(await buildTwoPagePdf(), { pages: [1, 2], signal: controller.signal })).rejects.toThrow(
      RasterisationCancelled,
    );
  }, 60_000);

  it("leaves the caller's bytes usable afterwards, because they are still needed to hash and extract", async () => {
    // pdf.js takes ownership of the buffer it is given and detaches it.
    const bytes = await buildTwoPagePdf();
    const before = bytes.byteLength;

    await rasterisePdfPages(bytes, { pages: [1] });

    expect(bytes.byteLength).toBe(before);
    expect(bytes[0]).toBe("%".charCodeAt(0));
  }, 60_000);
});

describe("recognising the pages that could not be read", () => {
  it("renders with the index profile DPI when the caller does not override it", async () => {
    let renderedDpi: number | undefined;

    await ocrPages(
      { bytes: await buildTwoPagePdf(), pages: [1] },
      {
        rasterise: async (_bytes, options) => {
          renderedDpi = options.dpi;
          return [];
        },
      },
    );

    expect(renderedDpi).toBe(ocrProfile("index").dpi);
  });

  it("returns one candidate per page, numbered as the extractor numbers them", async () => {
    const candidates = await ocrPages(
      { bytes: await buildTwoPagePdf(), pages: [1, 2] },
      { createRecogniser: async () => recogniser({ 1: "text of one", 2: "text of two" }) },
    );

    expect(candidates).toEqual([
      { page: 1, text: "text of one" },
      { page: 2, text: "text of two" },
    ]);
  }, 60_000);

  it("leaves out a page that recognised to nothing, rather than returning it empty", async () => {
    // An empty candidate is indistinguishable from a page that was read and found blank, and the
    // indexer treats those differently.
    const candidates = await ocrPages(
      { bytes: await buildTwoPagePdf(), pages: [1, 2] },
      { createRecogniser: async () => recogniser({ 1: "   \n  ", 2: "real text" }) },
    );

    expect(candidates).toEqual([{ page: 2, text: "real text" }]);
  }, 60_000);

  it("does not start an engine when there is nothing to read", async () => {
    let started = false;

    const candidates = await ocrPages(
      { bytes: new Uint8Array(), pages: [] },
      {
        createRecogniser: async () => {
          started = true;
          return recogniser({});
        },
      },
    );

    expect(candidates).toEqual([]);
    expect(started).toBe(false);
  });

  it("stops between pages when cancelled, keeping what it already read", async () => {
    const controller = new AbortController();
    const engine: TextRecogniser = {
      async recognise() {
        controller.abort();
        return { text: "read before the cancel", lines: [] };
      },
      async close() {},
    };

    const candidates = await ocrPages(
      { bytes: await buildTwoPagePdf(), pages: [1, 2], signal: controller.signal },
      { createRecogniser: async () => engine },
    );

    expect(candidates).toEqual([{ page: 1, text: "read before the cancel" }]);
  }, 60_000);

  it("does not start an engine when the cancel arrives as the last page finishes rendering", async () => {
    // The signal was read before rasterising and again between recognitions, but not in between.
    // Rendering the last page is not preemptible once begun, so a cancel landing during it was
    // noticed only after Tesseract had been started — a worker thread and a language file loaded
    // for a run that was already over.
    //
    // The rasteriser is injected because that window cannot be aimed at from outside: it aborts
    // and then returns normally, which is exactly what a render completing after a cancel does.
    const controller = new AbortController();
    let started = false;

    const candidates = await ocrPages(
      { bytes: await buildTwoPagePdf(), pages: [1], signal: controller.signal },
      {
        rasterise: async () => {
          controller.abort();
          return [{ page: 1, image: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), width: 10, height: 10 }];
        },
        createRecogniser: async () => {
          started = true;
          return recogniser({ 1: "text nobody asked for" });
        },
      },
    );

    expect(candidates).toEqual([]);
    expect(started).toBe(false);
  }, 60_000);

  it("treats a cancelled render as stopping, not as a failure", async () => {
    // Deterministic without a timer: `ocrPages` yields at its first `await`, so aborting on the
    // next line lands while the real rasteriser is in flight.
    const controller = new AbortController();
    let started = false;

    const pending = ocrPages(
      { bytes: await buildTwoPagePdf(), pages: [1, 2], signal: controller.signal },
      {
        createRecogniser: async () => {
          started = true;
          return recogniser({ 1: "text nobody asked for" });
        },
      },
    );
    controller.abort();

    expect(await pending).toEqual([]);
    expect(started).toBe(false);
  }, 60_000);

  it("releases the engine even when recognition fails", async () => {
    let closed = false;
    const engine: TextRecogniser = {
      async recognise() {
        throw new Error("the engine gave up");
      },
      async close() {
        closed = true;
      },
    };
    await expect(
      ocrPages({ bytes: await buildTwoPagePdf(), pages: [1] }, { createRecogniser: async () => engine }),
    ).rejects.toThrow("the engine gave up");
    expect(closed).toBe(true);
  }, 60_000);
});

describe("keeping the engine offline and out of the way", () => {
  it("terminates a worker when applying the index profile fails", async () => {
    let terminated = false;
    const worker = {
      async setParameters() {
        throw new Error("parameters refused");
      },
      async terminate() {
        terminated = true;
      },
    };

    await expect(configureTesseractWorker(worker, { preserve_interword_spaces: "1" })).rejects.toThrow(
      "parameters refused",
    );
    expect(terminated).toBe(true);
  });

  it("points it at language data inside this installation", () => {
    const options = tesseractOptions({});

    expect(options.langPath).toContain("4.0.0_best_int");
    expect(options.gzip).toBe(true);
  });

  it("turns the engine's own cache off, so nothing is written where the command was run", () => {
    // Left at its default, the worker writes `eng.traineddata` into `cachePath || '.'` —
    // `tesseract.js/src/worker-script/index.js:181`.
    expect(tesseractOptions({}).cacheMethod).toBe("none");
  });

  it("always hands the engine an error handler, because without one a rejected job throws", () => {
    // `tesseract.js/src/createWorker.js:216-219` throws from inside its own `worker.on("message")`
    // handler when a job is rejected and no handler was supplied. That is an uncaught exception on
    // the main thread: no exit code, nothing on stdout, a stack trace on stderr.
    expect(typeof tesseractWorkerOptions({}).errorHandler).toBe("function");
  });

  it("carries the offline settings through to the engine unchanged", () => {
    const options = tesseractWorkerOptions({});

    expect(options.cacheMethod).toBe("none");
    expect(options.langPath).toContain("4.0.0_best_int");
  });

  it("only installs a progress logger when somebody asked for progress", () => {
    expect(tesseractWorkerOptions({}).logger).toBeUndefined();
    expect(typeof tesseractWorkerOptions({}, () => undefined).logger).toBe("function");
  });

  it("uses the directory an installation names instead, when it names one", () => {
    writeFileSync(join(workDir, TRAINED_DATA_FILE), gzipSync(Buffer.from("stands in for language data")));

    expect(resolveOcrDataDirectory({ MARKPDF_OCR_DATA_DIR: workDir })).toBe(workDir);
  });

  it("refuses a file that is not compressed data at all, before the engine is ever started", () => {
    // The engine does not fail cleanly on one: it rejects the job and then dereferences an
    // already-deleted promise in its own message handler, which is an uncaught exception.
    writeFileSync(join(workDir, TRAINED_DATA_FILE), "plain text pretending to be language data");

    expect(() => resolveOcrDataDirectory({ MARKPDF_OCR_DATA_DIR: workDir })).toThrow(OcrDataUnavailableError);
  });

  it("refuses a named directory with no language data in it, rather than falling back to a download", () => {
    expect(() => resolveOcrDataDirectory({ MARKPDF_OCR_DATA_DIR: workDir })).toThrow(OcrDataUnavailableError);
  });

  it("ignores an empty setting and uses what is bundled", () => {
    expect(resolveOcrDataDirectory({ MARKPDF_OCR_DATA_DIR: "" })).toContain("4.0.0_best_int");
  });
});

describe("what the engine hands back", () => {
  it("takes the text when the result carries one", () => {
    expect(textFromRecognitionResult({ data: { text: "recognised words" } })).toBe("recognised words");
  });

  it("refuses a result with no text, rather than storing undefined as a page's contents", () => {
    // The result crosses a structured-clone boundary from a WebAssembly build in a worker thread.
    // Reaching straight for `result.data.text` would put `undefined` into an indexed chunk and
    // record the page as read.
    for (const malformed of [undefined, null, {}, { data: null }, { data: {} }, { data: { text: 42 } }, "text"]) {
      expect(() => textFromRecognitionResult(malformed)).toThrow(OcrEngineError);
    }
  });

  it("names the page unread rather than blank when it refuses", () => {
    expect(() => textFromRecognitionResult({})).toThrow(/cannot be treated as read/);
  });
});

describe("what the engine reports while it works", () => {
  it("takes a status and a fraction when the message carries both", () => {
    expect(progressFromLoggerMessage({ status: "recognizing text", progress: 0.5 })).toEqual({
      status: "recognizing text",
      progress: 0.5,
    });
  });

  it("drops a message it cannot read, because progress is decoration", () => {
    // Failing a document over a log line would be absurd; ignoring one is not.
    for (const malformed of [undefined, null, {}, { status: 1, progress: 0 }, { status: "x" }, { status: "x", progress: "half" }, { status: "x", progress: Number.NaN }]) {
      expect(progressFromLoggerMessage(malformed)).toBeNull();
    }
  });
});

describe("holding the engine open", () => {
  it("releases it when recognition returns something unusable", async () => {
    let closed = false;
    const engine: TextRecogniser = {
      async recognise() {
        return pageFromRecognitionResult({ data: {} });
      },
      async close() {
        closed = true;
      },
    };

    await expect(
      ocrPages({ bytes: await buildTwoPagePdf(), pages: [1] }, { createRecogniser: async () => engine }),
    ).rejects.toThrow(OcrEngineError);
    expect(closed).toBe(true);
  }, 60_000);
});

describe("the versioned OCR contract", () => {
  it("carries one version for every profile, so changing either reading is changing the contract", () => {
    expect(OCR_CONTRACT_VERSION).toBe(2);
    expect(OCR_EXTRACTION_VERSION).toBe(OCR_CONTRACT_VERSION);
  });

  it("reads for the index with the configuration that keeps rows intact", () => {
    // Measured against the real engine: the default page segmentation returns a financial table
    // one row per line, while sparse segmentation returns every cell as its own paragraph. The
    // index is the consumer that needs rows.
    expect(ocrProfile("index")).toEqual({
      engine: "LSTM_ONLY",
      pageSegmentation: "default",
      preserveInterwordSpaces: true,
      dpi: 200,
    });
  });

  it("reads for the window overlay with the configuration that keeps per-cell boxes", () => {
    // The overlay draws highlight rectangles from cell positions, which sparse segmentation
    // gives directly. Two profiles rather than one is the honest outcome of the measurement,
    // not an oversight.
    expect(ocrProfile("overlay")).toEqual({
      engine: "LSTM_ONLY",
      pageSegmentation: "SPARSE_TEXT",
      preserveInterwordSpaces: true,
      renderScale: 2,
    });
  });

  it("hands the engine exactly the parameters the index profile names", () => {
    // The default page segmentation is expressed by the absence of an override, which is how
    // the engine's own default is selected.
    expect(indexRecognitionParameters()).toEqual({ preserve_interword_spaces: "1" });
  });

  it("maps the engine named by the index profile to the installed runtime value", () => {
    const installedEngine = Symbol("installed LSTM engine");

    expect(indexEngineValue({ LSTM_ONLY: installedEngine })).toBe(installedEngine);
  });
});

describe("what the engine hands back with geometry", () => {
  it("returns the page's text and its lines, each word with the x extent it occupies", () => {
    const page = pageFromRecognitionResult(RECORDED_PAGE_10_RESULT);

    expect(page.text).toContain("Sales & Marketing 4110 4620 5170 5890");
    expect(page.lines.map((entry) => entry.text)).toEqual([
      "Approved operating plan",
      "Line item Approved 2026 Approved 2027 Approved 2028 Approved 2029",
      "Sales & Marketing 4110 4620 5170 5890",
      "R&D 3020 3310 3640 3980",
      "G&A 1180 1240 1310 1390",
    ]);

    const sales = page.lines.find((entry) => entry.text.startsWith("Sales"));
    expect(sales?.words.map((word) => word.text)).toEqual([
      "Sales",
      "&",
      "Marketing",
      "4110",
      "4620",
      "5170",
      "5890",
    ]);
    // The positions are what reconstruction clusters on, so they are stated exactly.
    expect(sales?.words[5]).toEqual({ text: "5170", x0: 1154, x1: 1226 });
  });

  it("keeps the strictness of the text half: a result with no text is not a page", () => {
    for (const malformed of [undefined, null, {}, { data: null }, { data: {} }, { data: { text: 42 } }, "text"]) {
      expect(() => pageFromRecognitionResult(malformed)).toThrow(OcrEngineError);
    }
  });

  it("returns no lines rather than failing when the engine produced no blocks", () => {
    // Reconstruction is a pure function of the lines: an empty list degrades to the flat text,
    // which is the behaviour every page had before geometry existed.
    expect(pageFromRecognitionResult({ data: { text: "words" } }).lines).toEqual([]);
    expect(pageFromRecognitionResult({ data: { text: "words", blocks: null } }).lines).toEqual([]);
  });

  it("skips a line or word it cannot place rather than trusting a shape it does not recognise", () => {
    const shaped = {
      data: {
        text: "t",
        blocks: [
          {
            paragraphs: [
              {
                lines: [
                  {
                    text: "kept line",
                    bbox: { x0: 0, y0: 0, x1: 100, y1: 30 },
                    words: [
                      { text: "kept", bbox: { x0: 0, y0: 0, x1: 40, y1: 30 } },
                      { text: "no bbox" },
                      "not a word",
                    ],
                  },
                  { text: "no bbox" },
                  "not a line",
                ],
              },
            ],
          },
        ],
      },
    };

    const page = pageFromRecognitionResult(shaped);

    expect(page.lines).toEqual([
      { text: "kept line", bbox: { x0: 0, y0: 0, x1: 100, y1: 30 }, words: [{ text: "kept", x0: 0, x1: 40 }] },
    ]);
  });
});

describe("reading a page that carries a table", () => {
  it("stores the reconstructed table, with its columns associated", async () => {
    const recognised = pageFromRecognitionResult(RECORDED_PAGE_10_RESULT);
    const engine: TextRecogniser = {
      async recognise() {
        return recognised;
      },
      async close() {},
    };

    const candidates = await ocrPages(
      { bytes: await buildTwoPagePdf(), pages: [1] },
      { createRecogniser: async () => engine },
    );

    expect(candidates).toEqual([{ page: 1, text: EXPECTED_PAGE_10_MARKDOWN }]);
  }, 60_000);

  it("stores the engine's own text with internal blank lines when the page carries no table", async () => {
    // The engine's text field is the authority for everything reconstruction declines to
    // rewrite. Losing its blank lines would merge blocks that every page before geometry kept
    // apart.
    const engine: TextRecogniser = {
      async recognise() {
        return { text: RECORDED_PAGE_10_RESULT.data.text, lines: [] };
      },
      async close() {},
    };

    const candidates = await ocrPages(
      { bytes: await buildTwoPagePdf(), pages: [1] },
      { createRecogniser: async () => engine },
    );

    expect(candidates).toEqual([{ page: 1, text: RECORDED_PAGE_10_RESULT.data.text.trim() }]);
  }, 60_000);
});
