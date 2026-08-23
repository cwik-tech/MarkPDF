import type { SemanticIndexRequest } from "./global";

export interface IndexableTab {
  path?: string | undefined;
  bytes: Uint8Array;
}

/**
 * Choose what the main process should hash and index.
 *
 * Always the bytes the renderer already has loaded, with the path carried only as metadata.
 *
 * Sending `{ kind: "path" }` would let the main process read the file again and hash whatever is
 * on disk now — while the page text in the same request came from the document loaded earlier.
 * If the file changed in between, the stored chunks would be keyed to a hash they did not come
 * from, which is exactly the silent mis-key the content hash exists to prevent. Phase 2 can make
 * main-process extraction from a path authoritative, because then both would come from the same
 * read.
 */
export function buildIndexSource(tab: IndexableTab): SemanticIndexRequest["source"] {
  return tab.path === undefined
    ? { kind: "bytes", bytes: tab.bytes }
    : { kind: "bytes", bytes: tab.bytes, path: tab.path };
}

/** How many unread pages are worth naming before the sentence becomes a list. */
const NAMEABLE_UNRESOLVED_PAGES = 6;

export interface SemanticIndexOutcome {
  /** What the tab's badge should say. */
  status: "ready";
  /** What the tab's progress line should read. */
  message: string;
}

/**
 * What a finished index job leaves on the tab.
 *
 * A document with a page nothing could read is two things at once, and the interface has to say
 * both. It **is** searchable — every other page is indexed, and refusing to search them would help
 * nobody — so the badge reads ready. And it is incomplete, so the line beside it says which pages
 * are missing. Reporting only the first half is the silent success this exists to stop: a reader
 * searches for something on the unread page, finds nothing, and concludes the document does not
 * mention it.
 *
 * Pages are named while there are few enough to name. Past that the count is the useful fact and a
 * list is just a long line, which is a different way of saying nothing.
 */
export function semanticIndexOutcome(result: {
  status: string;
  unresolvedPages?: readonly number[];
}): SemanticIndexOutcome {
  const unresolved = result.unresolvedPages ?? [];
  if (result.status !== "incomplete" || unresolved.length === 0) {
    return { status: "ready", message: "Semantic index ready" };
  }
  const which =
    unresolved.length === 1
      ? `page ${unresolved[0]}`
      : unresolved.length <= NAMEABLE_UNRESOLVED_PAGES
        ? `pages ${unresolved.join(", ")}`
        : `${unresolved.length} pages`;
  return { status: "ready", message: `Semantic index ready, but ${which} could not be read` };
}
