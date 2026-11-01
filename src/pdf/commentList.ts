/**
 * The comments a document has to show, in the order a reader meets them.
 *
 * One list, whoever wrote them. A comment another application left in the file and a comment made
 * here are the same thing to someone reading the document, and the pane beside the page shows them
 * together — sorted by where they sit rather than by which of the two produced them, so the list
 * reads down the document the way the pages do.
 *
 * `overlays` is left alone. It is a tab's own state, and `Array.prototype.sort` would otherwise
 * reorder the annotations in place on every render.
 */

import type { OverlayItem } from "../types";

export function listComments(overlays: readonly OverlayItem[]): OverlayItem[] {
  return overlays
    // An agent's accepted highlight is listed too. It has no note, but the pane is where a person
    // sees which annotations an agent wrote, and colour alone must not be the only place.
    .filter((overlay) => overlay.kind === "comment" || (overlay.kind === "highlight" && overlay.origin?.kind === "agent"))
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
}
