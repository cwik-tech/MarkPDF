import { describe, expect, it } from "vitest";
import { documentPreparationBadge, preparationIndexProgress } from "./documentPreparation";

/**
 * What the toolbar says while a document is being prepared.
 *
 * Preparing a document is three different jobs that a reader experiences as one wait: the window
 * checks whether the pages carry text, the main process recognises the ones that do not, and only
 * then are the embeddings built. Before this rule they were reported by two independent badges that
 * could both be wrong at once — recognition inside the index job was labelled "Checking index", and
 * the window's own result was hidden entirely, so a native-text document showed nothing and a
 * scanned one claimed to be indexing while it was actually reading pages.
 *
 * The rule is stated here rather than in the markup so the order of precedence — which of three
 * concurrent jobs the reader is told about — is a thing that can be checked.
 */

describe("choosing what the toolbar says while a document is prepared", () => {
  it("says nothing when no preparation is happening", () => {
    expect(documentPreparationBadge({})).toBeNull();
    expect(documentPreparationBadge({ indexProgress: { status: "idle" } })).toBeNull();
    expect(documentPreparationBadge({ indexProgress: { status: "ready", current: 9, total: 9 } })).toBeNull();
  });

  it("says the text layer is being checked while the window looks at it", () => {
    const badge = documentPreparationBadge({
      ocrStatus: "checking",
      ocrProgress: { status: "checking", message: "Checking text layer" },
    });
    expect(badge?.label).toBe("Checking text");
    expect(badge?.source).toBe("document");
    expect(badge?.percent, "the check has no knowable extent").toBeNull();
  });

  it("reports the check's result instead of claiming recognition ran", () => {
    // The old toolbar hid this outcome, so a reader who watched "Checking text" appear saw it
    // vanish with no statement of what was decided.
    const badge = documentPreparationBadge({
      ocrStatus: "skipped",
      ocrProgress: { status: "skipped", message: "PDF text layer detected" },
    });
    expect(badge?.label).toBe("Native text detected");
    expect(badge?.stage).toBe("native-text");
  });

  it("stops showing the result once it has been read", () => {
    expect(
      documentPreparationBadge({ ocrStatus: "skipped", ocrNoticeDismissed: true }),
    ).toBeNull();
  });

  it("counts the window's recognition by page, across the whole document", () => {
    const badge = documentPreparationBadge({
      ocrStatus: "running",
      ocrProgress: { status: "running", page: 2, totalPages: 5, progress: 0 },
    });
    expect(badge?.label).toBe("OCR 2/5");
    expect(badge?.percent, "one of five pages finished").toBe(20);
  });

  it("refines the current page's share without moving the whole-document bar backwards", () => {
    // The engine reports a fraction of the current page, and the page counter only ever rises.
    // Together they must never produce a bar that goes back: that is what makes a long recognition
    // feel broken even though it is working.
    const percents = [
      { page: 2, totalPages: 5, progress: 0 },
      { page: 2, totalPages: 5, progress: 0.5 },
      { page: 2, totalPages: 5, progress: 1 },
      { page: 3, totalPages: 5, progress: 0 },
    ].map(
      (progress) =>
        documentPreparationBadge({ ocrStatus: "running", ocrProgress: { status: "running", ...progress } })?.percent ?? 0,
    );

    expect(percents).toEqual([20, 30, 40, 40]);
  });

  it("falls back to a plain label when recognition has not said which page yet", () => {
    const badge = documentPreparationBadge({
      ocrStatus: "running",
      ocrProgress: { status: "running", message: "Starting OCR" },
    });
    expect(badge?.label).toBe("OCR running");
    expect(badge?.percent).toBeNull();
  });

  it("calls recognition inside the index job OCR, not indexing", () => {
    // The whole point of the new progress state. This event is emitted by the main process while
    // it recognises a page the extractor could not read, and it used to arrive as "checking".
    const badge = documentPreparationBadge({
      indexProgress: { status: "ocr", current: 1, total: 4, message: "Reading page 10 with OCR" },
    });
    expect(badge?.label).toBe("OCR 1/4");
    expect(badge?.source, "it belongs to the index job's badge").toBe("index");
    expect(badge?.percent).toBe(25);
  });

  it("labels embedding progress as indexing", () => {
    const badge = documentPreparationBadge({
      indexProgress: { status: "indexing", current: 3, total: 12 },
    });
    expect(badge?.label).toBe("Index 3/12");
    expect(badge?.percent).toBe(25);
  });

  it("keeps the model download as its own state", () => {
    const badge = documentPreparationBadge({
      indexProgress: { status: "downloading", current: 25, total: 200 },
    });
    expect(badge?.label).toBe("Downloading model");
    expect(badge?.stage).toBe("downloading");
    expect(badge?.percent).toBe(13);
  });

  it("shows a visible sliver rather than an empty bar at the very start of measured work", () => {
    const badge = documentPreparationBadge({
      indexProgress: { status: "indexing", current: 0, total: 400 },
    });
    expect(badge?.percent).toBe(4);
  });

  it("gives no bar to work whose extent is unknown", () => {
    expect(documentPreparationBadge({ indexProgress: { status: "checking" } })?.percent).toBeNull();
    expect(documentPreparationBadge({ indexProgress: { status: "indexing" } })?.percent).toBeNull();
    expect(
      documentPreparationBadge({ indexProgress: { status: "indexing", current: 3, total: 0 } })?.percent,
    ).toBeNull();
  });

  it("shows one badge at a time, and prefers the recognition that is actually running", () => {
    // Both jobs report at once while a scan is prepared. Two badges side by side made the reader
    // choose which to believe; recognition is the one doing the work the wait is made of.
    const badge = documentPreparationBadge({
      ocrStatus: "running",
      ocrProgress: { status: "running", page: 1, totalPages: 4, progress: 0 },
      indexProgress: { status: "checking", message: "Reading document" },
    });
    expect(badge?.label).toBe("OCR 1/4");
    expect(badge?.source).toBe("document");
  });

  it("prefers the index job's own work to the window's finished result", () => {
    const badge = documentPreparationBadge({
      ocrStatus: "skipped",
      ocrProgress: { status: "skipped" },
      indexProgress: { status: "indexing", current: 2, total: 8 },
    });
    expect(badge?.label).toBe("Index 2/8");
    expect(badge?.source).toBe("index");
  });

  it("prefers recognition inside the index job to the window's finished result", () => {
    const badge = documentPreparationBadge({
      ocrStatus: "skipped",
      indexProgress: { status: "ocr", current: 1, total: 1 },
    });
    expect(badge?.label).toBe("OCR 1/1");
    expect(badge?.source).toBe("index");
  });

  it("reports a failure from whichever job failed", () => {
    expect(documentPreparationBadge({ ocrStatus: "error" })).toMatchObject({
      label: "OCR failed",
      source: "document",
    });
    expect(documentPreparationBadge({ indexProgress: { status: "error" } })).toMatchObject({
      label: "Index failed",
      source: "index",
    });
  });

  it("says nothing about recognition the window finished with, once indexing is over too", () => {
    expect(
      documentPreparationBadge({
        ocrStatus: "ready",
        ocrProgress: { status: "ready", page: 4, totalPages: 4 },
        indexProgress: { status: "ready" },
      }),
    ).toBeNull();
  });
});

describe("choosing between a model download and the active tab's own progress", () => {
  const ocr = { status: "ocr" as const, current: 2, total: 9, message: "Reading page 10 with OCR" };
  const download = { status: "downloading" as const, current: 40, total: 200 };

  it("prefers the tab's recognition to a model download running beside it", () => {
    // Both are real, and they are not the same wait. A download that started for some other tab
    // used to win outright, which put "Downloading model" over a document whose pages were being
    // recognised — the exact phase this work exists to stop hiding.
    expect(preparationIndexProgress(download, "ocr", ocr)).toEqual(ocr);
  });

  it("prefers the tab's failure to a model download running beside it", () => {
    const failed = { status: "error" as const, message: "Indexing failed" };
    expect(preparationIndexProgress(download, "error", failed)).toEqual(failed);
  });

  it("shows the download while the tab is only checking or embedding", () => {
    const indexing = { status: "indexing" as const, current: 3, total: 12 };
    expect(preparationIndexProgress(download, "indexing", indexing)).toEqual(download);
  });

  it("shows the download when the tab has no index job of its own", () => {
    expect(preparationIndexProgress(download, "idle", undefined)).toEqual(download);
    expect(preparationIndexProgress(download, undefined, undefined)).toEqual(download);
  });

  it("shows the tab's own progress when nothing is downloading", () => {
    expect(preparationIndexProgress(null, "ocr", ocr)).toEqual(ocr);
  });

  it("shows nothing for a tab that has finished and no download", () => {
    expect(preparationIndexProgress(null, "ready", { status: "ready" })).toBeUndefined();
    expect(preparationIndexProgress(null, "idle", { status: "idle" })).toBeUndefined();
    expect(preparationIndexProgress(null, undefined, undefined)).toBeUndefined();
  });

  it("puts recognition on the badge even while a model is downloading", () => {
    // The end-to-end statement of the bug, through the rule the toolbar actually uses.
    const badge = documentPreparationBadge({
      indexProgress: preparationIndexProgress(download, "ocr", ocr),
    });
    expect(badge?.label).toBe("OCR 2/9");
  });
});
