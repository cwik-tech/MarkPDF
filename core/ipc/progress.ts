import { SemanticRequestError } from "./requests.js";

export type SemanticProgressKind = "index" | "model";

export interface SemanticProgressDetail {
  status: "checking" | "ocr" | "indexing" | "downloading" | "ready";
  current?: number;
  total?: number;
  message?: string;
}

export interface SemanticProgressEvent {
  jobId: string;
  kind: SemanticProgressKind;
  progress: SemanticProgressDetail;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** A whole number of pages, which is what recognition counts in. */
function isPageCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Narrow a progress event arriving from the main process.
 *
 * The renderer receives this as `unknown` over the bridge, and it drives visible state, so a
 * malformed event must be discarded rather than rendered as `NaN/undefined` in the toolbar.
 * Returns null instead of throwing: a bad progress event should be ignored, not break indexing.
 */
export function parseSemanticProgressEvent(raw: unknown): SemanticProgressEvent | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const jobId = record.jobId;
  const kind = record.kind;
  if (typeof jobId !== "string" || jobId.length === 0) return null;
  if (kind !== "index" && kind !== "model") return null;

  const progress = record.progress;
  if (typeof progress !== "object" || progress === null || Array.isArray(progress)) return null;
  const detail = progress as Record<string, unknown>;

  const status = detail.status;
  if (
    status !== "checking" &&
    status !== "ocr" &&
    status !== "indexing" &&
    status !== "downloading" &&
    status !== "ready"
  ) {
    return null;
  }

  // Recognition is the one phase whose counters are not optional. The others may legitimately have
  // no extent — "Checking index" is looking at a database, not working through a list — but every
  // OCR event this application emits names one page out of a known set. An OCR event without a
  // usable position in that set describes no work, so it is dropped rather than rendered as a badge
  // that says "OCR undefined/undefined" or a bar drawn from nothing.
  if (status === "ocr") {
    const current = detail.current;
    const total = detail.total;
    if (!isPageCount(current) || !isPageCount(total)) return null;
    if (total < 1 || current < 1 || current > total) return null;
    return {
      jobId,
      kind,
      progress: {
        status,
        current,
        total,
        ...(typeof detail.message === "string" ? { message: detail.message } : {}),
      },
    };
  }

  return {
    jobId,
    kind,
    progress: {
      status,
      ...(isCount(detail.current) ? { current: detail.current } : {}),
      ...(isCount(detail.total) ? { total: detail.total } : {}),
      ...(typeof detail.message === "string" ? { message: detail.message } : {}),
    },
  };
}

/** Thrown only by callers that treat a malformed event as a programming error. */
export function requireSemanticProgressEvent(raw: unknown): SemanticProgressEvent {
  const parsed = parseSemanticProgressEvent(raw);
  if (parsed === null) throw new SemanticRequestError("Malformed semantic progress event.");
  return parsed;
}
