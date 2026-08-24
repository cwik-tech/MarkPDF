import type { OpenDocumentsReport, ReportedOpenDocument } from "./global";

/**
 * The part of a tab this report is about.
 *
 * A structural subset rather than `DocumentTab`, following the same shape `semanticSource.ts`
 * uses: it says exactly which fields leave the window, and it lets this be tested without
 * constructing a loaded PDF.
 */
export interface ProjectableTab {
  kind: "pdf" | "markdown";
  id: string;
  name: string;
  path?: string | undefined;
  pageCount?: number | undefined;
  /** Read by nothing here. Present so that omitting it from the report is a visible decision. */
  currentPage?: number | undefined;
  markdown?: string | undefined;
  semanticContentHash?: string | undefined;
  dirty: boolean;
}

/**
 * What this window has open, for the benefit of processes that cannot see it.
 *
 * **Narrow on purpose.** Scan progress, searches and highlights do not alter this report. Page
 * position does because it is useful context for an assistant, but the caller gives page-only
 * changes a longer coalescing delay.
 *
 * Markdown text crosses the private preload bridge so main can maintain the bounded snapshot an
 * MCP reply reads. It is never put in the metadata file and PDF bytes never cross this report.
 *
 * A Markdown tab is reported like any other. Its current buffer is carried to main so the open-tab
 * read can answer for saved and unsaved notes without handing an agent the file's path.
 */
export function projectOpenDocuments(
  tabs: readonly ProjectableTab[],
  activeTabId: string | null,
): OpenDocumentsReport {
  const documents: ReportedOpenDocument[] = tabs.map((tab) => ({
    tabId: tab.id,
    kind: tab.kind,
    name: tab.name,
    path: tab.path ?? null,
    // A Markdown tab has no pages. Zero rather than absent, so every entry has the same shape.
    pageCount: tab.kind === "pdf" ? (tab.pageCount ?? 0) : 0,
    currentPage: tab.kind === "pdf" ? (tab.currentPage ?? 1) : null,
    contentHash: tab.semanticContentHash ?? null,
    contentSnapshot: tab.kind === "markdown" ? (tab.markdown ?? "") : null,
    unsavedChanges: tab.dirty,
  }));

  // A tab can close between a state change and this report. Naming a front tab that is not in the
  // list would leave the one document a caller is most likely to ask for unreachable.
  const active = documents.some((entry) => entry.tabId === activeTabId) ? activeTabId : null;

  return { activeTabId: active, documents };
}

const RESPONSIVE_PUBLISH_DELAY = 250;
const PAGE_ONLY_PUBLISH_DELAY = 750;

function withoutCurrentPage(report: OpenDocumentsReport): string {
  return JSON.stringify({
    ...report,
    documents: report.documents.map(({ currentPage: _currentPage, ...entry }) => entry),
  });
}

/** Page turns can arrive in bursts. Identity, content and save-state changes stay responsive. */
export function publishDelayFor(
  previous: OpenDocumentsReport | null,
  next: OpenDocumentsReport,
): number {
  if (previous === null) return RESPONSIVE_PUBLISH_DELAY;
  return withoutCurrentPage(previous) === withoutCurrentPage(next)
    ? PAGE_ONLY_PUBLISH_DELAY
    : RESPONSIVE_PUBLISH_DELAY;
}
