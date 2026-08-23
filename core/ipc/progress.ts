import { SemanticRequestError } from "./requests.js";

export type SemanticProgressKind = "index" | "model";

export interface SemanticProgressDetail {
  status: "checking" | "indexing" | "downloading" | "ready";
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
  if (status !== "checking" && status !== "indexing" && status !== "downloading" && status !== "ready") {
    return null;
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
