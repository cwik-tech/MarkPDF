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
