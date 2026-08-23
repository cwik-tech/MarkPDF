import { extractPagesFromPdf } from "./pdfInspector.js";

/** Page text somebody has already produced for a page the extractor could not read. */
export interface OcrPageCandidate {
  /** 1-based, matching the page numbers the adapter reports. */
  page: number;
  text: string;
}

/** Where a page's text came from. `none` means nothing could read it. */
export type PageSource = "pdf" | "ocr" | "none";

/**
 * What became of a page, which is not the same question as where its text came from.
 *
 * - `read` — it has text.
 * - `empty` — something read it and there was nothing on it. A genuinely blank page.
 * - `unresolved` — it needed recognising and nothing recognised it. **Its emptiness is a gap, not
 *   a fact about the document**, and anything that stores or serves it has to say so; otherwise the
 *   next reader cannot tell it apart from `empty` and will never go back for it.
 */
export type PageStatus = "read" | "empty" | "unresolved";

export interface ReadPage {
  page: number;
  /** The text to use for this page. Empty exactly when `source` is `none`. */
  markdown: string;
  source: PageSource;
  /** True when the structural extractor could not read the page, whatever happened afterwards. */
  needsOcr: boolean;
  status: PageStatus;
}

/** What the rule below needs to know about a page. A structural subset of the extractor's output. */
export interface RecognisablePage {
  needsOcr: boolean;
  markdown: string;
}

/**
 * Whether this page still has to be read by recognising it.
 *
 * Two ways in, and the second is the defensive one. The extractor's own flag decides the ordinary
 * case. But a page it says it read and returned nothing for has contradicted itself, and believing
 * the flag over the result is how a page with words on it gets stored as blank — the one failure
 * that looks exactly like a correct answer. Measured against `@firecrawl/pdf-inspector` 1.17.0 this
 * second case does not arise, which is precisely why it is worth guarding rather than trusting: it
 * is a claim about a dependency's behaviour, not about ours.
 *
 * Whitespace is nothing. A page whose text layer is a single newline has no words on it.
 *
 * It cannot cascade. An empty page is empty however the flag reads, and `ocrOnlyPages` still bounds
 * which pages a caller is willing to pay to recognise.
 */
export function pageNeedsRecognition(page: RecognisablePage): boolean {
  return page.needsOcr || page.markdown.trim().length === 0;
}

export interface ReadDocumentInput {
  bytes: Uint8Array;
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
  /** How many pages this read had to recognise, because the extractor could not read them. */
  recognisedHere: number;
  /**
   * Pages that needed recognising and did not get it, ascending.
   *
   * Empty is the ordinary case. Anything else means this document is incomplete, and a caller that
   * reports it as read has told somebody the words are all there when they are not.
   */
  unresolvedPages: number[];
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

  const wanted = input.ocrOnlyPages === undefined ? null : new Set(input.ocrOnlyPages);
  const unread = extracted.pages
    .filter((page) => pageNeedsRecognition(page) && (wanted === null || wanted.has(page.page)))
    .map((page) => page.page);

  let recovered: readonly OcrPageCandidate[] = [];
  let askedAbout: readonly number[] = [];
  if (unread.length > 0 && input.resolveOcr !== undefined) {
    askedAbout = unread;
    if (cancelled()) return { status: "cancelled" };
    recovered = await input.resolveOcr({
      bytes: input.bytes,
      pages: unread,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    // Recognition is long and not preemptible, so the signal is read the instant it returns.
    if (cancelled()) return { status: "cancelled" };
  }

  const textByPage = new Map(recovered.map((candidate) => [candidate.page, candidate.text]));
  // Which pages recognition was actually put to. A page outside this set was never asked about —
  // because nothing was supplied to ask, or because `ocrOnlyPages` narrowed it away — and its
  // emptiness therefore says nothing about the page.
  const asked = new Set(askedAbout);

  const pages: ReadPage[] = extracted.pages.map((page) => {
    if (pageNeedsRecognition(page)) {
      const text = textByPage.get(page.page)?.trim() ?? "";
      if (text.length > 0) {
        return { page: page.page, markdown: text, source: "ocr", needsOcr: page.needsOcr, status: "read" };
      }
      return {
        page: page.page,
        markdown: "",
        source: "none",
        needsOcr: page.needsOcr,
        status: asked.has(page.page) ? "empty" : "unresolved",
      };
    }
    const text = page.markdown.trim();
    return { page: page.page, markdown: text, source: "pdf", needsOcr: false, status: "read" };
  });

  return {
    status: "read",
    pageCount: extracted.pageCount,
    pages,
    recognisedHere: recovered.length,
    unresolvedPages: pages.filter((page) => page.status === "unresolved").map((page) => page.page),
  };
}
