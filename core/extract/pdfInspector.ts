import { classifyPdfAsync, extractPagesMarkdownAsync } from "@firecrawl/pdf-inspector";

/**
 * The only file in this repository that imports `@firecrawl/pdf-inspector`.
 *
 * Everything the package returns is treated as external input and reconstructed here, field by
 * field. Nothing crosses into core unvalidated, because the package mixes two page-numbering
 * bases inside a single return object and a systematically wrong page number is worse than no
 * result at all — it produces a citation that looks right and is not.
 */
export class PdfInspectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfInspectorError";
  }
}

/**
 * MarkPDF's internal page number: 1-based, and only constructible by a normalizer below.
 *
 * The brand is what stops an un-normalized engine value reaching a stored citation by accident.
 * A plain `number` would let any of the engine's bases flow straight through.
 */
export type PageNumber = number & { readonly __brand: "PageNumber1Based" };

/**
 * Name a rejected value without ever throwing while doing so.
 *
 * Deliberately no `JSON.stringify` on objects: it throws on a BigInt and recurses forever on a
 * circular structure, and a guard that dies while composing its own message loses the diagnosis
 * and surfaces as an unrelated `TypeError`. Every branch here is total.
 */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  // Narrowed by the check itself rather than asserted, so `value.length` needs no cast.
  if (typeof value === "string") {
    return `string ${JSON.stringify(value.length > 60 ? `${value.slice(0, 60)}…` : value)}`;
  }
  const kind = typeof value;
  if (kind === "number" || kind === "boolean" || kind === "bigint") return `${kind} ${String(value)}`;
  if (kind === "symbol") return "a symbol";
  if (kind === "function") return "a function";
  if (kind === "undefined") return "undefined";
  return Array.isArray(value) ? `an array of ${value.length}` : "an object";
}

function requireEngineInteger(field: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new PdfInspectorError(`${field} must be a whole number; received ${describeValue(value)}.`);
  }
  return value;
}

function requireInDocument(field: string, page: number, pageCount: number): PageNumber {
  if (page < 1 || page > pageCount) {
    throw new PdfInspectorError(`${field} normalized to page ${page}, outside 1..${pageCount}.`);
  }
  // The single point where a branded page number is constructed. Every path into it has just
  // checked both the type and the range, which is the property the brand stands for.
  return page as PageNumber;
}

/*
 * One named function per page-bearing engine field, each carrying its own base as a literal.
 *
 * Deliberately not one shared function with an offset parameter: a parameter is a constant a
 * caller can pass wrongly, and it would also mean a single mutation breaks every normalizer at
 * once, so no test could show which one it protects.
 */

/** `pages[].page` is 0-based. Verified against 1.17.0: page 0 carried the page-one sentinel. */
export function pageFromMarkdownResult(engineValue: unknown, pageCount: number): PageNumber {
  const field = "pages[].page";
  return requireInDocument(field, requireEngineInteger(field, engineValue) + 1, pageCount);
}

/** `pagesWithTables` is 1-based. Verified: returns [2] for a table drawn on the second page. */
export function pageFromTablesList(engineValue: unknown, pageCount: number): PageNumber {
  const field = "pagesWithTables";
  return requireInDocument(field, requireEngineInteger(field, engineValue), pageCount);
}

/**
 * `pagesWithColumns` is 1-based. Verified: returns [2] when the second page is set in columns.
 *
 * The fixture has to be dense to fill it — nine short lines per column read as ordinary prose
 * and report nothing, forty-five lines are recognised — which is why an earlier pass mistook
 * this field for one that could only be checked against its declaration.
 */
export function pageFromColumnsList(engineValue: unknown, pageCount: number): PageNumber {
  const field = "pagesWithColumns";
  return requireInDocument(field, requireEngineInteger(field, engineValue), pageCount);
}

/** `pagesNeedingOcr` is 1-based. Verified: returns [2] when the second page is a scan. */
export function pageFromOcrList(engineValue: unknown, pageCount: number): PageNumber {
  const field = "pagesNeedingOcr";
  return requireInDocument(field, requireEngineInteger(field, engineValue), pageCount);
}

/** `ocrReasonsByPage[].page` is 1-based. Verified: {"page":2,"reasons":["scanned"]}. */
export function pageFromOcrReason(engineValue: unknown, pageCount: number): PageNumber {
  const field = "ocrReasonsByPage[].page";
  return requireInDocument(field, requireEngineInteger(field, engineValue), pageCount);
}

export interface ExtractedPage {
  page: PageNumber;
  markdown: string;
  needsOcr: boolean;
  ocrReason?: string;
}

export interface OcrReasonsForPage {
  page: PageNumber;
  reasons: string[];
}

export interface ExtractedDocument {
  pageCount: number;
  /** Exactly one entry per page, `1..pageCount`, in source order. */
  pages: ExtractedPage[];
  pagesWithTables: PageNumber[];
  pagesWithColumns: PageNumber[];
  pagesNeedingOcr: PageNumber[];
  ocrReasonsByPage: OcrReasonsForPage[];
}

/** A real type predicate, so narrowing is the compiler's conclusion rather than an assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(field: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new PdfInspectorError(`${field} must be an object; received ${describeValue(value)}.`);
  }
  return value;
}

function requireArray(field: string, value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new PdfInspectorError(`${field} must be an array; received ${describeValue(value)}.`);
  }
  return value;
}

function requireString(field: string, value: unknown): string {
  if (typeof value !== "string") {
    throw new PdfInspectorError(`${field} must be a string; received ${describeValue(value)}.`);
  }
  return value;
}

/** Reject a repeat rather than collapse it: a duplicate is a changed contract, not noise. */
function requireDistinct(field: string, pages: readonly PageNumber[]): void {
  const seen = new Set<number>();
  for (const page of pages) {
    if (seen.has(page)) {
      throw new PdfInspectorError(`${field} names page ${page} more than once; duplicates are refused, not collapsed.`);
    }
    seen.add(page);
  }
}

function requirePageList(
  field: string,
  value: unknown,
  pageCount: number,
  normalize: (engineValue: unknown, pageCount: number) => PageNumber,
): PageNumber[] {
  const pages = requireArray(field, value).map((entry) => normalize(entry, pageCount));
  requireDistinct(field, pages);
  return pages;
}

function toPage(field: string, raw: unknown, pageCount: number): ExtractedPage {
  const record = requireRecord(field, raw);
  const needsOcr = record.needsOcr;
  if (typeof needsOcr !== "boolean") {
    throw new PdfInspectorError(`${field}.needsOcr must be a boolean; received ${describeValue(needsOcr)}.`);
  }
  const reason = record.ocrReason;
  if (reason !== undefined && typeof reason !== "string") {
    throw new PdfInspectorError(`${field}.ocrReason must be a string when present; received ${describeValue(reason)}.`);
  }
  // A reason explains why a page could not be read, so it cannot belong to a page the engine
  // says it read fine. The converse is not required: `ocrReason` is optional in the package's
  // own declaration, and demanding one would reject ordinary output whenever the engine knows a
  // page is unreliable but cannot name the cause.
  if (reason !== undefined && !needsOcr) {
    throw new PdfInspectorError(`${field}.ocrReason is set but needsOcr is false; the engine contradicted itself.`);
  }
  return {
    page: pageFromMarkdownResult(record.page, pageCount),
    markdown: requireString(`${field}.markdown`, record.markdown),
    needsOcr,
    ...(reason === undefined ? {} : { ocrReason: reason }),
  };
}

/**
 * Rebuild the engine's result as an `ExtractedDocument`, or refuse it.
 *
 * Refusing rather than repairing is the whole point. Sorting pages into order, dropping a
 * duplicate, or clamping an out-of-range number would each hide the one thing that must never be
 * hidden: that the engine's contract changed underneath us. Every repair produces an index that
 * cites pages confidently and wrongly.
 */
export function toExtractedDocument(raw: unknown, pageCount: number): ExtractedDocument {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new PdfInspectorError(`pageCount must be an integer of at least 1; received ${describeValue(pageCount)}.`);
  }
  const result = requireRecord("extraction result", raw);
  const rawPages = requireArray("pages", result.pages);

  if (rawPages.length !== pageCount) {
    throw new PdfInspectorError(
      `pages must contain exactly one entry per page; the document has ${pageCount} but the engine returned ${rawPages.length}.`,
    );
  }

  const pages = rawPages.map((entry, position) => toPage(`pages[${position}]`, entry, pageCount));
  for (const [position, page] of pages.entries()) {
    if (page.page !== position + 1) {
      throw new PdfInspectorError(
        `pages must arrive in source order, one per page: entry ${position} is page ${page.page} where page ${position + 1} was expected.`,
      );
    }
  }

  const ocrReasonsByPage = requireArray("ocrReasonsByPage", result.ocrReasonsByPage).map((entry, position) => {
    const record = requireRecord(`ocrReasonsByPage[${position}]`, entry);
    return {
      page: pageFromOcrReason(record.page, pageCount),
      reasons: requireArray(`ocrReasonsByPage[${position}].reasons`, record.reasons).map((reason, index) =>
        requireString(`ocrReasonsByPage[${position}].reasons[${index}]`, reason),
      ),
    };
  });
  requireDistinct("ocrReasonsByPage", ocrReasonsByPage.map((entry) => entry.page));

  const pagesWithTables = requirePageList("pagesWithTables", result.pagesWithTables, pageCount, pageFromTablesList);
  const pagesWithColumns = requirePageList("pagesWithColumns", result.pagesWithColumns, pageCount, pageFromColumnsList);
  const pagesNeedingOcr = requirePageList("pagesNeedingOcr", result.pagesNeedingOcr, pageCount, pageFromOcrList);

  // The engine states the same fact twice — a per-page flag and a document-level list — and the
  // two must agree. Believing one and ignoring the other is how a page the engine said it could
  // not read gets indexed as though it had been read.
  const flagged = pages.filter((page) => page.needsOcr).map((page) => page.page);
  const listed = new Set<number>(pagesNeedingOcr);
  for (const page of flagged) {
    if (!listed.has(page)) {
      throw new PdfInspectorError(
        `page ${page} has needsOcr set but pagesNeedingOcr does not name it; the engine contradicted itself.`,
      );
    }
  }
  const flaggedSet = new Set<number>(flagged);
  for (const page of pagesNeedingOcr) {
    if (!flaggedSet.has(page)) {
      throw new PdfInspectorError(
        `pagesNeedingOcr names page ${page} but that page's needsOcr is not set; the engine contradicted itself.`,
      );
    }
  }
  for (const entry of ocrReasonsByPage) {
    if (!listed.has(entry.page)) {
      throw new PdfInspectorError(
        `ocrReasonsByPage explains page ${entry.page}, which pagesNeedingOcr does not name.`,
      );
    }
  }

  return { pageCount, pages, pagesWithTables, pagesWithColumns, pagesNeedingOcr, ocrReasonsByPage };
}

/**
 * The page count, and only the page count, from a classification.
 *
 * `classifyPdfAsync` returns third-party output like anything else, so it is narrowed here
 * rather than destructured at the call site — an unchecked `pageCount` of `undefined` would turn
 * every `1..pageCount` range check into a no-op. Its `pagesNeedingOcr` is deliberately not read:
 * that field is 0-based and names every page of an image-based document even when a single page
 * is a scan, so it is a document-level signal only.
 */
export function classificationPageCount(raw: unknown): number {
  const classification = requireRecord("classification", raw);
  const pageCount = classification.pageCount;
  if (typeof pageCount !== "number" || !Number.isInteger(pageCount) || pageCount < 1) {
    throw new PdfInspectorError(
      `classification.pageCount must be an integer of at least 1; received ${describeValue(pageCount)}.`,
    );
  }
  return pageCount;
}

/**
 * Combine the two engine calls, with the page count coming from the classification.
 *
 * Separated from the async wrapper so the choice of *source* is testable. Counting the pages the
 * extraction returned and then checking the extraction against that count proves nothing; a
 * count obtained independently is what makes a truncated extraction detectable.
 */
export function toExtractedDocumentFromEngine(rawClassification: unknown, rawExtraction: unknown): ExtractedDocument {
  return toExtractedDocument(rawExtraction, classificationPageCount(rawClassification));
}

/**
 * The two package calls this adapter makes, injectable for one purpose only.
 *
 * `@firecrawl/pdf-inspector` offers no cancellation: both calls run the parse on the libuv pool
 * and return promises that cannot be abandoned. So the only testable property of a cancelled
 * extraction is which call was never *started*, and that is invisible against the real binding.
 * Replacing this narrow boundary is what makes the between-call check provable. The package
 * import stays in this file, which is the rule that matters.
 */
export interface PdfEngine {
  classify(buffer: Buffer): Promise<unknown>;
  extractPages(buffer: Buffer): Promise<unknown>;
}

const nativeEngine: PdfEngine = {
  classify: (buffer) => classifyPdfAsync(buffer),
  extractPages: (buffer) => extractPagesMarkdownAsync(buffer),
};

export interface ExtractOptions {
  signal?: AbortSignal;
  engine?: PdfEngine;
}

/** Cancellation is an outcome, not a failure; a malformed result is still a thrown error. */
export type ExtractionResult = { status: "extracted"; document: ExtractedDocument } | { status: "cancelled" };

/**
 * Extract every page of a document.
 *
 * Full-document only, deliberately. `extractPagesMarkdown` accepts a **0-based** `pages` array —
 * a third convention, on the input side — and Phase 2 has no caller that needs partial
 * extraction. Not offering it means no page number ever crosses this adapter inward, so the
 * inverse conversion has nothing to get wrong. A future partial API adds its own named inverse
 * at the point it has a real caller.
 *
 * `pageCount` comes from the classification, which is a document-level signal and is used for
 * nothing else here — its own `pagesNeedingOcr` is never read, because it names every page of an
 * image-based document even when only one page is a scan. Measured at 3.4 ms against 109 ms for
 * the extraction itself, which buys an independent count to check completeness against.
 *
 * The signal is read three times: before the cheap classification, between the two calls, and
 * after the expensive extraction. The middle check is the one that earns its place — a cancel
 * arriving during the 3 ms call would otherwise still pay for the 109 ms one. Neither call is
 * preemptible once started, and nothing here pretends otherwise.
 */
export async function extractPagesFromPdf(bytes: Uint8Array, options: ExtractOptions = {}): Promise<ExtractionResult> {
  const { signal } = options;
  // Read through a call: after one direct `signal.aborted === true` check the compiler narrows
  // the property to `false` and every later check becomes provably dead code.
  const cancelled = (): boolean => signal?.aborted === true;
  const engine = options.engine ?? nativeEngine;
  const buffer = Buffer.from(bytes);

  if (cancelled()) return { status: "cancelled" };
  const rawClassification = await engine.classify(buffer);

  if (cancelled()) return { status: "cancelled" };
  const rawExtraction = await engine.extractPages(buffer);

  if (cancelled()) return { status: "cancelled" };
  return { status: "extracted", document: toExtractedDocumentFromEngine(rawClassification, rawExtraction) };
}
