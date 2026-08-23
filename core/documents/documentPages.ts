import { AccessDeniedError, requireAccess, type Allowlist } from "../consent/allowlist.js";
import { readDocumentPages, type OcrPageCandidate } from "../extract/readDocumentPages.js";
import { findIndexedDocument } from "../index/documentLookup.js";
import type { MarkdownPage } from "../index/markdownBlocks.js";
import { MARKDOWN_ENGINE_ID, MARKDOWN_VERSION } from "../models.js";
import type { SemanticStore, StoredDocument } from "../store/index.js";

export type DocumentPages =
  | { status: "found"; document: StoredDocument | null; pages: MarkdownPage[]; fromIndex: boolean }
  /** Not in the index, and either not on disk or not permitted to be looked for there. */
  | { status: "not-indexed" }
  /** In the index, but indexed before its text was kept. Re-indexing restores it. */
  | { status: "no-stored-text"; document: StoredDocument }
  /**
   * In the index, but with no path recorded — so a caller classed as reading the file has nothing
   * to prove consent against. Indexing from bytes alone leaves a document in this state.
   */
  | { status: "no-recorded-path"; document: StoredDocument }
  | { status: "denied"; path: string }
  | { status: "cancelled" };

/**
 * Which access class a caller is operating under.
 *
 * This is the security boundary the whole surface is organised around, so it is named rather than
 * inferred from a boolean:
 *
 * - `index-only` never touches the filesystem. A document the index does not hold is reported as
 *   such. This is what makes a tool genuinely need no filesystem permission, rather than merely
 *   usually not need one.
 * - `index-first` answers from the index when it can and reads the file otherwise, with
 *   permission. Reading is the fallback, so a document already indexed costs nothing.
 * - `filesystem` proves read permission **first, always** — even when the answer will come from
 *   the index. A caller in this class is doing something classed as reading the file, and a
 *   withdrawn grant must refuse it whether or not a cached copy happens to exist.
 */
export type DocumentAccess = "index-only" | "index-first" | "filesystem";

export interface DocumentPagesInput {
  path?: string;
  contentHash?: string;
  readFile: (path: string) => Promise<Uint8Array>;
  access: DocumentAccess;
  resolveOcr?: (request: {
    bytes: Uint8Array;
    pages: readonly number[];
    signal?: AbortSignal;
  }) => Promise<readonly OcrPageCandidate[]>;
  signal?: AbortSignal;
}

/**
 * A document's pages, from the index first and the filesystem only if allowed.
 *
 * One operation for every surface that needs a document's text: the command line's `outline`, and
 * the MCP `outline`, `read_pages` and `to_markdown` tools. Written once because *which* order a
 * caller gets is a security property rather than a performance one, and a second implementation of
 * it is a second chance for one surface to open a file it did not have to — or to skip a check it
 * did have to.
 *
 * The order is not the same for every caller, and `DocumentAccess` below is where that is decided.
 * An `index-only` caller never touches the filesystem at all. An `index-first` caller is answered
 * from the index when it can be, so asking about an already-indexed document needs no permission.
 * A `filesystem` caller proves read permission before anything else, cached text included — which
 * is what `to_markdown` is, and why a withdrawn grant refuses it even though the index still holds
 * the words.
 */
export async function resolveDocumentPages(
  store: SemanticStore,
  allowlist: Allowlist,
  input: DocumentPagesInput,
): Promise<DocumentPages> {
  // Read each path at most once. The lookup hashes the file to identify it by content and the
  // extraction below needs the same bytes; without this, every first look at a document opens it
  // twice, which for a large PDF is the most expensive thing this operation does.
  const reads = new Map<string, Promise<Uint8Array>>();
  const readOnce = (path: string): Promise<Uint8Array> => {
    const started = reads.get(path);
    if (started !== undefined) return started;
    const pending = input.readFile(path);
    reads.set(path, pending);
    return pending;
  };

  const allowFilesystem = input.access !== "index-only";

  /**
   * The path this request is about, resolved once.
   *
   * A document named only by its hash still has a path — the one it was indexed from — and both
   * the consent check below and the extraction at the end need that same answer. Deriving it
   * twice is how they came to disagree: consent was proved against the stored path while
   * extraction looked only at what the caller typed, so a document named by hash with no cached
   * Markdown was reported as not indexed with a live grant in place.
   */
  const knownByHash =
    input.path === undefined && input.contentHash !== undefined && allowFilesystem
      ? store.getDocument(input.contentHash)
      : null;
  const target = input.path ?? knownByHash?.filePath ?? undefined;

  const denyOrThrow = (path: string): DocumentPages | null => {
    try {
      requireAccess(allowlist, path, "read");
      return null;
    } catch (error) {
      if (error instanceof AccessDeniedError) return { status: "denied", path };
      throw error;
    }
  };

  // A caller classed as reading the file proves that first, whatever the index happens to hold. A
  // cached copy is a convenience, not a second route around a grant that has been withdrawn.
  if (input.access === "filesystem") {
    if (target === undefined) {
      return knownByHash === null ? { status: "not-indexed" } : { status: "no-recorded-path", document: knownByHash };
    }
    const refused = denyOrThrow(target);
    if (refused !== null) return refused;
  }

  const lookup = await findIndexedDocument(store, allowlist, {
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.contentHash === undefined ? {} : { contentHash: input.contentHash }),
    filesystemFallback: allowFilesystem,
    readFile: readOnce,
  });

  if (lookup.status === "found") {
    const cached = store.getMarkdown(lookup.document.id, MARKDOWN_ENGINE_ID, MARKDOWN_VERSION);
    if (cached !== null) {
      return {
        status: "found",
        document: lookup.document,
        // The cache records the text, not how it was read. Heading detection and page identity do
        // not depend on that, and claiming a source the cache never stored would be worse.
        pages: cached.map((page) => ({ page: page.page, markdown: page.markdown, source: "pdf" })),
        fromIndex: true,
      };
    }
    if (!allowFilesystem) return { status: "no-stored-text", document: lookup.document };
  }

  if (lookup.status === "denied") return { status: "denied", path: lookup.path };
  if (!allowFilesystem) return { status: "not-indexed" };
  if (target === undefined) {
    // Named by hash, and either unknown or indexed from bytes with no path recorded. The second
    // is worth saying out loud: nothing is wrong with the request, there is simply no file to go
    // back to and no path for a grant to be about.
    return knownByHash === null ? { status: "not-indexed" } : { status: "no-recorded-path", document: knownByHash };
  }

  // Resolved rather than merely checked: the containment decision is made about the canonical
  // spelling, and that is the spelling the bytes are then read from.
  let resolved: string;
  try {
    resolved = requireAccess(allowlist, target, "read");
  } catch (error) {
    if (error instanceof AccessDeniedError) return { status: "denied", path: target };
    throw error;
  }

  const read = await readDocumentPages({
    bytes: await readOnce(resolved),
    ...(input.resolveOcr === undefined ? {} : { resolveOcr: input.resolveOcr }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (read.status === "cancelled") return { status: "cancelled" };

  return {
    status: "found",
    document: lookup.status === "found" ? lookup.document : null,
    pages: read.pages.map((page) => ({
      page: page.page,
      markdown: page.markdown,
      source: page.source === "ocr" ? "ocr" : "pdf",
    })),
    fromIndex: false,
  };
}
