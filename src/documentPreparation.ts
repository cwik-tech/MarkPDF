import type { OcrProgress, OcrStatus, SemanticIndexProgress, SemanticIndexStatus } from "./types";

/**
 * What the toolbar says while a document is being prepared.
 *
 * Preparing a document is three jobs a reader experiences as one wait. The window checks whether the
 * pages carry text. The main process recognises the ones that do not. Only then are the embeddings
 * built. They overlap, they belong to different processes, and before this rule two independent
 * badges reported them — so a scanned document could say "Checking index" for the minutes it spent
 * reading pages, and a native-text document said nothing at all about the check it had just run.
 *
 * Stating the choice here, away from the markup, is what makes the order of precedence checkable:
 * which of three concurrent jobs the reader is told about, and what number is under the bar.
 */

export type PreparationStage =
  | "checking-text"
  | "native-text"
  | "ocr"
  | "downloading"
  | "checking-index"
  | "indexing"
  | "failed";

export interface PreparationBadge {
  stage: PreparationStage;
  label: string;
  /** The bar's width as a percentage, or `null` when the work's extent is unknown. */
  percent: number | null;
  /** Which job this is: the window's own reading, or the index job in the main process. */
  source: "document" | "index";
}

export interface PreparationInput {
  ocrStatus?: OcrStatus | undefined;
  ocrProgress?: OcrProgress | undefined;
  /** Whether the text-layer check's result has already been shown long enough to be read. */
  ocrNoticeDismissed?: boolean | undefined;
  indexProgress?: SemanticIndexProgress | undefined;
}

/**
 * Which index-side progress the badge should describe: this tab's, or a model download.
 *
 * They are separate jobs with separate lifetimes. The download belongs to no tab — any tab, or the
 * settings dialog, can have started it — while recognition and embedding belong to the document in
 * front of the reader. Preferring the download outright, which is what the toolbar used to do, put
 * "Downloading model" over a document whose pages were being recognised: the one phase this whole
 * change exists to stop hiding, hidden again by an unrelated job.
 *
 * So the tab wins whenever it is doing the work the reader is waiting on — recognising pages — or
 * has failed. Otherwise the download is the more informative thing to say, because a tab that is
 * merely "checking" is waiting for those very weights.
 */
export function preparationIndexProgress(
  modelDownload: SemanticIndexProgress | null | undefined,
  tabStatus: SemanticIndexStatus | undefined,
  tabProgress: SemanticIndexProgress | undefined,
): SemanticIndexProgress | undefined {
  const tabIsBusy =
    tabStatus !== undefined && tabStatus !== "idle" && tabStatus !== "ready";
  const ownWork = tabIsBusy ? tabProgress : undefined;
  if (ownWork !== undefined && (ownWork.status === "ocr" || ownWork.status === "error")) {
    return ownWork;
  }
  return modelDownload ?? ownWork;
}

/** The smallest bar worth drawing, so work that has started does not look like work that has not. */
const MINIMUM_VISIBLE_PERCENT = 4;

/** A fraction of known work, as a percentage. `null` whenever the extent is not actually known. */
function fractionPercent(current: number | undefined, total: number | undefined): number | null {
  if (typeof current !== "number" || typeof total !== "number") return null;
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;
  const percent = Math.round((current / total) * 100);
  return Math.min(100, Math.max(MINIMUM_VISIBLE_PERCENT, percent));
}

/**
 * How far the window's recognition has got through the whole document.
 *
 * Two numbers combined: which page it is on, and how far the engine says it is through that page.
 * The page counter only rises and the engine's fraction is always of the current page, so the
 * result never moves backwards — which is the whole reason to combine them rather than show the
 * engine's fraction on its own.
 */
function rendererOcrPercent(progress: OcrProgress | undefined): number | null {
  const page = progress?.page;
  const totalPages = progress?.totalPages;
  if (typeof page !== "number" || typeof totalPages !== "number" || totalPages <= 0) return null;
  const withinPage =
    typeof progress?.progress === "number" && Number.isFinite(progress.progress)
      ? Math.min(1, Math.max(0, progress.progress))
      : 0;
  const completed = Math.min(totalPages, Math.max(0, page - 1) + withinPage);
  return Math.min(100, Math.max(MINIMUM_VISIBLE_PERCENT, Math.round((completed / totalPages) * 100)));
}

/**
 * The one badge to show, or nothing.
 *
 * Precedence, and why. A failure is reported before anything else, because it is the only state the
 * reader has to act on. Recognition comes next, in either process, because it is the slow work the
 * wait is actually made of and the phase this rule exists to stop hiding. The index job's own
 * states follow. The window's finished result — "Native text detected" — comes last, so a brief
 * notice about work that is over can never cover work that is still running.
 */
export function documentPreparationBadge(input: PreparationInput): PreparationBadge | null {
  const index = input.indexProgress;

  if (input.ocrStatus === "error") {
    return { stage: "failed", label: "OCR failed", percent: null, source: "document" };
  }
  if (index?.status === "error") {
    return { stage: "failed", label: "Index failed", percent: null, source: "index" };
  }

  if (input.ocrStatus === "running") {
    const page = input.ocrProgress?.page;
    const totalPages = input.ocrProgress?.totalPages;
    const counted = typeof page === "number" && typeof totalPages === "number" && totalPages > 0;
    return {
      stage: "ocr",
      label: counted ? `OCR ${page}/${totalPages}` : "OCR running",
      percent: rendererOcrPercent(input.ocrProgress),
      source: "document",
    };
  }

  if (index?.status === "ocr") {
    const { current, total } = index;
    const counted = typeof current === "number" && typeof total === "number" && total > 0;
    return {
      stage: "ocr",
      label: counted ? `OCR ${current}/${total}` : "OCR running",
      percent: fractionPercent(current, total),
      source: "index",
    };
  }

  if (input.ocrStatus === "checking") {
    return { stage: "checking-text", label: "Checking text", percent: null, source: "document" };
  }

  if (index?.status === "downloading") {
    return {
      stage: "downloading",
      label: "Downloading model",
      percent: fractionPercent(index.current, index.total),
      source: "index",
    };
  }

  if (index?.status === "indexing") {
    const { current, total } = index;
    const counted = typeof current === "number" && typeof total === "number" && total > 0;
    return {
      stage: "indexing",
      label: counted ? `Index ${current}/${total}` : "Indexing",
      percent: fractionPercent(current, total),
      source: "index",
    };
  }

  if (index?.status === "checking") {
    return { stage: "checking-index", label: "Checking index", percent: null, source: "index" };
  }

  // The check's result, said once. Worth saying at all because silence used to be the only way to
  // learn that a document's pages carry text and nothing was recognised.
  if (input.ocrStatus === "skipped" && input.ocrNoticeDismissed !== true) {
    return { stage: "native-text", label: "Native text detected", percent: null, source: "document" };
  }

  return null;
}
