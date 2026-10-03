/**
 * Whether this reader may change an annotation, in one place.
 *
 * An annotation the document carries was written by someone else and is never written back by
 * MarkPDF, so every control that would edit or remove one is offering a change that goes nowhere:
 * the card would show the new text while the saved file went on carrying the author's. The rule
 * lives here rather than at each control because the controls are scattered — a card editor, a
 * generic inspector, a delete handle, the Delete key — and one of them not knowing the rule is how
 * this was reported.
 *
 * Annotations made here carry no `source` and are owned, which is what every overlay written
 * before the document's own annotations were read is.
 */

import type { OverlayItem } from "../types";

export function ownsOverlay(overlay: OverlayItem | null | undefined): boolean {
  return overlay !== null && overlay !== undefined && overlay.source !== "document";
}
