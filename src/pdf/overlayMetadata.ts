/**
 * Reading the annotations a saved document carries.
 *
 * The JSON behind this arrives in a PDF keyword, which means anything could have written it: an
 * older MarkPDF, another tool, or a save that was interrupted. Nothing in it is believed on the
 * strength of having parsed — every field is checked before it becomes an overlay, and an entry
 * that fails is dropped rather than opened as an annotation nobody can explain.
 *
 * The two readings that matter to a reader sit at opposite ends of the format's history. A
 * document saved before annotations could be anchored to text carries `x`, `y`, `width` and
 * `height` and no fragments, and must still open as the single box it described. A document saved
 * with an anchored annotation must keep every line it was anchored to.
 */

import type { OverlayItem, OverlayKind, OverlayRect } from "../types";

const overlayKinds: readonly OverlayKind[] = [
  "text",
  "comment",
  "highlight",
  "signature",
  "bookmark",
];

export function parsePersistedOverlays(value: unknown): OverlayItem[] {
  if (!Array.isArray(value)) return [];

  const overlays: OverlayItem[] = [];
  for (const entry of value) {
    const overlay = readOverlay(entry);
    if (overlay !== null) overlays.push(overlay);
  }
  return overlays;
}

function readOverlay(value: unknown): OverlayItem | null {
  if (!isRecord(value)) return null;

  const id = value.id;
  const kind = value.kind;
  if (typeof id !== "string" || !id) return null;
  if (!isOverlayKind(kind)) return null;
  if (!isPageNumber(value.page)) return null;

  const x = value.x;
  const y = value.y;
  const width = value.width;
  const height = value.height;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null;

  const overlay: OverlayItem = { id, kind, page: value.page, x, y, width, height };

  if (typeof value.text === "string") overlay.text = value.text;
  if (isFiniteNumber(value.fontSize)) overlay.fontSize = value.fontSize;
  if (typeof value.color === "string") overlay.color = value.color;
  if (typeof value.dataUrl === "string") overlay.dataUrl = value.dataUrl;
  if (typeof value.minimized === "boolean") overlay.minimized = value.minimized;

  const fragments = readFragments(value.fragments);
  if (fragments !== null) overlay.fragments = fragments;

  return overlay;
}

/**
 * The anchored lines, or nothing at all.
 *
 * All or none on purpose. A list that survived in part would paint some of the lines the reader
 * selected and silently drop the rest, which looks like an annotation they never made. Falling
 * back to the enclosing box is the honest reading of geometry that cannot be verified.
 */
function readFragments(value: unknown): OverlayRect[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const fragments: OverlayRect[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const { x, y, width, height } = entry;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
    if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null;
    if (width <= 0 || height <= 0) return null;
    fragments.push({ x, y, width, height });
  }

  return fragments;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOverlayKind(value: unknown): value is OverlayKind {
  return typeof value === "string" && overlayKinds.some((kind) => kind === value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPageNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
