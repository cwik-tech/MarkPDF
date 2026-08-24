import { hasTerminalControlCharacter } from "../text/safeForTerminal.js";
import type { OpenDocumentKind } from "./openDocuments.js";

/**
 * Validation for what a window says about its own tabs.
 *
 * The renderer is not trusted, and this is the receiving boundary. What arrives here is written to
 * a file that another process reads and acts on, so a name that can repaint a terminal, a page
 * count that is not a number, or a list long enough to make the file itself the problem must all
 * stop here rather than becoming somebody else's input.
 *
 * It lives in core rather than in the Electron shell so it can be tested without a browser, and so
 * that the one description of this shape sits next to the reader that consumes it.
 */
export class OpenDocumentsRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenDocumentsRequestError";
  }
}

export interface OpenDocumentsPayload {
  activeTabId: string | null;
  documents: PublishedOpenDocument[];
}

export interface PublishedOpenDocument {
  tabId: string;
  kind: OpenDocumentKind;
  name: string;
  path: string | null;
  pageCount: number;
  currentPage: number | null;
  contentHash: string | null;
  contentSnapshot: string | null;
  unsavedChanges: boolean;
}

/**
 * How many tabs one window may report.
 *
 * Far above what anyone opens on purpose and far below what would make the file awkward. It is a
 * bound on a file this process writes about itself, not a judgement about how somebody works.
 */
const MAX_DOCUMENTS = 200;
/** Long enough for any real file name, and for any path the platforms this ships to allow. */
const MAX_NAME = 1024;
const MAX_PATH = 4096;
const CONTENT_HASH = /^[0-9a-f]{64}$/;

function refuse(message: string): never {
  throw new OpenDocumentsRequestError(message);
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse(`${what} must be an object.`);
  return value as Record<string, unknown>;
}

function requireText(value: unknown, what: string, limit: number): string {
  if (typeof value !== "string" || value.length === 0) refuse(`${what} must be a non-empty string.`);
  if (value.length > limit) refuse(`${what} must be at most ${limit} characters.`);
  // The same rule the command line applies to its own arguments. This text reaches a terminal
  // through refusals and remedies, where an escape sequence can forge a line.
  if (hasTerminalControlCharacter(value)) refuse(`${what} contains a control character, which MarkPDF will not use.`);
  return value;
}

function requireKind(value: unknown): OpenDocumentKind {
  if (value === "pdf" || value === "markdown") return value;
  refuse("kind must be pdf or markdown.");
}

function requirePageCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    refuse("pageCount must be a whole number of pages, and not a negative one.");
  }
  return value;
}

function requireOptionalHash(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !CONTENT_HASH.test(value)) {
    refuse("contentHash must be null or 64 lower-case hexadecimal characters.");
  }
  return value;
}

function requireOptionalPath(value: unknown): string | null {
  if (value === null) return null;
  return requireText(value, "path", MAX_PATH);
}

function requireFlag(value: unknown, what: string): boolean {
  // Present but not a boolean is a caller error, never a false: reporting a document as saved
  // when the window said something unrecognisable is the mistake that reads as an answer.
  if (typeof value !== "boolean") refuse(`${what} must be true or false.`);
  return value;
}

function requireCurrentPage(value: unknown, kind: OpenDocumentKind, pageCount: number): number | null {
  if (kind === "markdown") {
    if (value !== null) refuse("currentPage must be null for Markdown.");
    return null;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > pageCount) {
    refuse("currentPage must be a whole number from 1 through pageCount for a PDF.");
  }
  return value;
}

function requireContentSnapshot(value: unknown, kind: OpenDocumentKind): string | null {
  if (kind === "pdf") {
    if (value !== null) refuse("contentSnapshot must be null for a PDF.");
    return null;
  }
  if (typeof value !== "string") refuse("contentSnapshot must be text for Markdown.");
  return value;
}

/**
 * Read one window's report, or refuse it.
 *
 * **The active tab must be one of the documents reported.** A window naming a front tab it did not
 * list would leave the one document a caller is most likely to ask for unreachable, and tab
 * identities must be distinct because a reference is built from one — two documents sharing an
 * identity would silently become the same tab.
 */
export function parseOpenDocumentsPayload(raw: unknown): OpenDocumentsPayload {
  const record = requireRecord(raw, "an open-documents report");

  const rawDocuments = record.documents;
  if (!Array.isArray(rawDocuments)) refuse("documents must be a list.");
  if (rawDocuments.length > MAX_DOCUMENTS) {
    refuse(`documents must name at most ${MAX_DOCUMENTS} open documents; received ${rawDocuments.length}.`);
  }

  const documents: PublishedOpenDocument[] = [];
  const seen = new Set<string>();
  for (const entry of rawDocuments) {
    // Named `fields` rather than `document`: `core/boundaries.test.ts` reads a bare `document.` as
    // a reach for the browser global, and in a program full of documents that net is worth keeping
    // taut rather than loosening for a local variable.
    const fields = requireRecord(entry, "an open document");
    const tabId = requireText(fields.tabId, "tabId", MAX_NAME);
    if (seen.has(tabId)) refuse(`two open documents share the tabId ${tabId}.`);
    seen.add(tabId);
    const kind = requireKind(fields.kind);
    const pageCount = requirePageCount(fields.pageCount);
    documents.push({
      tabId,
      kind,
      name: requireText(fields.name, "name", MAX_NAME),
      path: requireOptionalPath(fields.path),
      pageCount,
      currentPage: requireCurrentPage(fields.currentPage, kind, pageCount),
      contentHash: requireOptionalHash(fields.contentHash),
      contentSnapshot: requireContentSnapshot(fields.contentSnapshot, kind),
      unsavedChanges: requireFlag(fields.unsavedChanges, "unsavedChanges"),
    });
  }

  const rawActive = record.activeTabId;
  if (rawActive !== null && typeof rawActive !== "string") refuse("activeTabId must be a tab identifier or null.");
  if (rawActive !== null && !seen.has(rawActive)) {
    refuse("activeTabId must name one of the documents reported.");
  }

  return { activeTabId: rawActive, documents };
}
