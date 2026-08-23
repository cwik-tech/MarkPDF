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
  semanticContentHash?: string | undefined;
  dirty: boolean;
}

/**
 * What this window has open, for the benefit of processes that cannot see it.
 *
 * **Narrow on purpose.** Everything a person does constantly — turning pages, watching a scan
 * progress, running a search, dragging a highlight — must produce a report identical to the last
 * one, because the caller writes a file only when the report changes. Page position is the clearest
 * case: it is the most volatile thing about a tab and of no use to anything outside the window, so
 * it is read here and deliberately not carried.
 *
 * **No text and no bytes.** Document content leaves this program through bounded replies and
 * nowhere else. A copy of a document inside a metadata file would be neither bounded nor counted.
 *
 * A Markdown tab is reported like any other. It cannot be read by the tools that read PDFs, and
 * saying so is the point: an agent told only about PDFs, while a Markdown file is at the front,
 * would be handed a document the person is not looking at.
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
    contentHash: tab.semanticContentHash ?? null,
    unsavedChanges: tab.dirty,
  }));

  // A tab can close between a state change and this report. Naming a front tab that is not in the
  // list would leave the one document a caller is most likely to ask for unreachable.
  const active = documents.some((entry) => entry.tabId === activeTabId) ? activeTabId : null;

  return { activeTabId: active, documents };
}
