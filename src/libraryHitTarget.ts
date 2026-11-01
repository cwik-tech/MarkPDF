/**
 * Where a click on a library hit goes.
 *
 * An open tab holding the same indexed document is the first choice, matched by the content hash the
 * index recorded for it — never by name, because two open documents can share one. Otherwise the
 * recorded path is opened. A document indexed without a path cannot be opened from the library, and
 * the pane says so rather than doing nothing.
 */
export type LibraryHitTarget =
  | { kind: "switch"; tabId: string }
  | { kind: "open"; path: string }
  | { kind: "unavailable"; message: string };

export interface TabIdentity {
  id: string;
  kind: "pdf" | "markdown";
  semanticContentHash?: string;
}

export function libraryHitTarget(
  tabs: readonly TabIdentity[],
  hit: { contentHash: string; path: string | null },
): LibraryHitTarget {
  const open = tabs.find((tab) => tab.kind === "pdf" && tab.semanticContentHash === hit.contentHash);
  if (open !== undefined) return { kind: "switch", tabId: open.id };
  if (hit.path === null) return { kind: "unavailable", message: "This document is in the index without a file path." };
  return { kind: "open", path: hit.path };
}

/** The message for a hit whose recorded file could not be opened. */
export function missingFileMessage(path: string): string {
  return `This document is in the index, but its file is not at ${path}.`;
}

/**
 * Whether a library reply still answers the latest request.
 *
 * Every change of query, mode or scope sends a new request with a new id. A reply to an older one
 * describes a search the person has already replaced, and showing it would put the wrong results
 * under the current query.
 */
export function acceptsLibraryResponse(requestId: number, latestRequestId: number): boolean {
  return requestId === latestRequestId;
}
