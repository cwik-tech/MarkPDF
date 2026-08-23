import type { SemanticProgressEvent } from "./global";
import type { PdfTab, SemanticIndexProgress } from "./types";

export type SemanticTabPatch = Pick<
  PdfTab,
  "semanticIndexStatus" | "semanticIndexProgress" | "semanticIndexError"
>;

/**
 * What a progress event from the main process should change.
 *
 * Two shapes because the events describe two different things. Indexing belongs to a tab and
 * drives that tab's status badge. A model download belongs to no tab: it feeds the app's
 * download banner or the settings dialog's percentage, depending on which of them asked for it.
 * Routing is by job identifier, which is what the requester chose when it started the download.
 */
export type SemanticProgressUpdate =
  | { kind: "index"; tabId: string; patch: SemanticTabPatch }
  | { kind: "model"; jobId: string; progress: SemanticIndexProgress; percent: number | null };

/** What the caller knows about a tab's own index job, or `undefined` if it has none. */
export type LocalIndexJob = { controller: AbortController } | undefined;

/**
 * The event has already been narrowed in the preload, where core's validation lives — the
 * renderer must not import core. Kept separate from the subscription so the mapping is testable
 * without an Electron window.
 *
 * `findIndexJob` is how the caller says whether it still owns the job the event describes.
 * Omit it in a context that has no tabs, such as the settings dialog, where index events are
 * never routed at all.
 */
export function semanticProgressToUpdate(
  event: SemanticProgressEvent,
  findIndexJob?: (tabId: string) => LocalIndexJob,
): SemanticProgressUpdate | null {
  if (event.kind === "model") {
    const { current, total } = event.progress;
    const percent =
      typeof current === "number" && typeof total === "number" && total > 0
        ? Math.round((current / total) * 100)
        : null;
    return { kind: "model", jobId: event.jobId, progress: event.progress, percent };
  }

  // An index event is only meaningful while this window still owns the job. Inference cannot be
  // interrupted mid-call, so after a cancel the main process keeps emitting for a moment; and a
  // job is marked cancelled before it is removed, so both states have to stop updates. Without
  // this gate, disabling semantic search leaves a tab reading "Indexing" it can never leave.
  const job = findIndexJob?.(event.jobId);
  if (job === undefined || job.controller.signal.aborted) return null;

  // A "ready" progress event arrives immediately before indexDocument returns, so it can reach
  // the interface before the invoke result does. Acting on it would mark the tab searchable
  // while semanticContentHash is still unset, and a search then finds nothing. Only the
  // resolved result sets hash and ready together.
  if (event.progress.status === "ready") return null;

  return {
    kind: "index",
    tabId: event.jobId,
    patch: {
      semanticIndexStatus: event.progress.status,
      semanticIndexProgress: event.progress,
      semanticIndexError: undefined,
    },
  };
}
