import { extractPagesFromPdf } from "./pdfInspector.js";

/** Page text somebody has already produced for a page the extractor could not read. */
export interface OcrPageCandidate {
  /** 1-based, matching the page numbers the adapter reports. */
  page: number;
  text: string;
}

/** Where a page's text came from. `none` means nothing could read it. */
export type PageSource = "pdf" | "ocr" | "none";

export interface ReadPage {
  page: number;
  /** The text to use for this page. Empty exactly when `source` is `none`. */
  markdown: string;
  source: PageSource;
  /** True when the structural extractor could not read the page, whatever happened afterwards. */
  needsOcr: boolean;
}

export interface ReadDocumentInput {
  bytes: Uint8Array;
  /**
   * Text a caller has already produced for unreadable pages.
   *
   * The application fills this in: its renderer has rasterised and scanned those pages for the
   * visible text layer, so recognising them again would cost a second full pass to arrive
   * somewhere no better.
   */
  ocrCandidates?: readonly OcrPageCandidate[];
  /**
   * Which pages the caller is actually going to use, when it already knows.
   *
   * A bound on the work, not a filter applied afterwards: `convert --pages 1` on a 400-page
   * scanned book must not rasterise and recognise 400 pages to then discard 399. Omit it and
   * every unreadable page is offered for recognition.
   *
   * It narrows recognition only. Every page of the document is still returned, because the page
   * count is what tells a caller that a selection names a page the document does not have.
   */
  ocrOnlyPages?: readonly number[];
  /**
   * Read the pages nobody else accounted for.
   *
   * Injected rather than imported, so that reading a document does not drag a rasteriser and a
   * recognition engine into every caller. Anything it throws ends the read: a document whose
   * scanned pages could not be recognised is incomplete, and treating it as merely short would
   * hand back a document with pages silently missing.
   */
  resolveOcr?: (request: {
    bytes: Uint8Array;
    pages: readonly number[];
    signal?: AbortSignal;
  }) => Promise<readonly OcrPageCandidate[]>;
  signal?: AbortSignal;
}

export interface ReadDocument {
  status: "read";
  pageCount: number;
  /** Every page of the document, in order, including the ones nothing could read. */
  pages: ReadPage[];
  /** How many candidates the caller supplied. */
  candidatesOffered: number;
  /** How many were actually used, which is fewer when one names a page that read fine. */
  candidatesUsed: number;
  /** How many pages were recognised during this read rather than supplied. */
  recognisedHere: number;
}

export type ReadDocumentResult = ReadDocument | { status: "cancelled" };

/**
 * Read every page of a document: structure first, recognition only where structure failed.
 *
 * **One composition, three callers.** Indexing, outlining and converting all need the same
 * answer to the same question, and three copies of "extract, then find the pages that need OCR,
 * then merge" is three chances for one of them to skip the second half — which is exactly how a
 * scanned page ends up silently blank in one command and readable in another.
 *
 * A page the extractor flags as unreadable is never indexed from what it scraped off the scan.
 * Those fragments look like ordinary text and would cite a page nobody actually read — the same
 * class of confident wrongness as a bad page number, and harder to notice.
 */
export async function readDocumentPages(input: ReadDocumentInput): Promise<ReadDocumentResult> {
  // Read through a call: after one direct `signal.aborted === true` check the compiler narrows
  // the property to `false` and every later check becomes provably dead code.
  const cancelled = (): boolean => input.signal?.aborted === true;

  const extraction = await extractPagesFromPdf(input.bytes, {
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (extraction.status === "cancelled") return { status: "cancelled" };
  const extracted = extraction.document;

  const supplied = input.ocrCandidates ?? [];
  for (const candidate of supplied) {
    // The request guard validates each candidate's shape but runs before anything knows how many
    // pages the document has. Checking here, where the count is known, stops a candidate for a
    // page that does not exist from being silently dropped.
    if (candidate.page > extracted.pages.length) {
      throw new Error(`OCR candidate names page ${candidate.page}, but the document has ${extracted.pages.length} pages.`);
    }
  }

  const accountedFor = new Set(supplied.map((candidate) => candidate.page));
  const wanted = input.ocrOnlyPages === undefined ? null : new Set(input.ocrOnlyPages);
  const unread = extracted.pages
    .filter((page) => page.needsOcr && !accountedFor.has(page.page) && (wanted === null || wanted.has(page.page)))
    .map((page) => page.page);

  let recovered: readonly OcrPageCandidate[] = [];
  if (unread.length > 0 && input.resolveOcr !== undefined) {
    if (cancelled()) return { status: "cancelled" };
    recovered = await input.resolveOcr({
      bytes: input.bytes,
      pages: unread,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    // Recognition is long and not preemptible, so the signal is read the instant it returns.
    if (cancelled()) return { status: "cancelled" };
  }

  const textByPage = new Map([...supplied, ...recovered].map((candidate) => [candidate.page, candidate.text]));
  let candidatesUsed = 0;

  const pages: ReadPage[] = extracted.pages.map((page) => {
    if (page.needsOcr) {
      const text = textByPage.get(page.page)?.trim() ?? "";
      if (text.length === 0) return { page: page.page, markdown: "", source: "none", needsOcr: true };
      candidatesUsed += 1;
      return { page: page.page, markdown: text, source: "ocr", needsOcr: true };
    }
    const text = page.markdown.trim();
    return {
      page: page.page,
      markdown: text,
      source: text.length === 0 ? "none" : "pdf",
      needsOcr: false,
    };
  });

  return {
    status: "read",
    pageCount: extracted.pageCount,
    pages,
    candidatesOffered: supplied.length + recovered.length,
    candidatesUsed,
    recognisedHere: recovered.length,
  };
}
