/**
 * The two shapes an annotation can have, and the arithmetic that produces them.
 *
 * A reader makes an annotation in one of two ways, and they are not the same thing. Dropping a
 * highlight or a comment on the page makes **one rectangle**, wherever it was dropped. Dragging
 * across text makes an annotation **anchored to the text**, which is as many rectangles as the
 * selection has lines — and the blank page between two lines belongs to neither of them. Collapsing
 * the second into the first is how a two-line highlight ends up painting over the gap.
 *
 * `OverlayGeometry` keeps them apart so no caller can read one as the other by accident, and
 * `overlayGeometry` is the single place a stored overlay is sorted into one or the other. An
 * overlay written before this distinction existed carries no fragments and is a box, which is what
 * it always was.
 *
 * Everything here is pure. Where the browser's rectangles come from is a layout question only a
 * rendered page can answer, and it is covered by `tests/e2e/text-selection-annotations.spec.ts`.
 */

import type { OverlayItem, OverlayRect } from "../types";
import { clipRectToLayer, type LayerRect } from "./textLayerSearch";

/** How a page is drawn right now: its size on screen, and the rotation and zoom that produced it. */
export interface PageView {
  width: number;
  height: number;
  rotation: number;
  zoom: number;
}

/** An annotation the reader placed: one rectangle, and nothing else to know about it. */
export interface BoxOverlayGeometry {
  shape: "box";
  bounds: OverlayRect;
}

/**
 * An annotation anchored to selected text.
 *
 * `fragments` are offsets from `bounds`, one per rectangle the browser reported for the selection.
 * Storing them relative rather than absolute is what lets the reader drag the annotation as one
 * object: moving `bounds` moves every fragment with it, and nothing has to be rewritten.
 *
 * `bounds` is the enclosing box. It places the popover and carries the group's own interactions,
 * and it is never what gets painted.
 */
export interface TextSelectionOverlayGeometry {
  shape: "textSelection";
  bounds: OverlayRect;
  fragments: OverlayRect[];
}

export type OverlayGeometry = BoxOverlayGeometry | TextSelectionOverlayGeometry;

/**
 * Two rectangles close enough to be the same one, in page units.
 *
 * A range that crosses a wrapper element is reported once for the wrapper and once for the run
 * inside it. Both are painted translucently, so keeping both would darken those lines and only
 * those lines.
 */
const DUPLICATE_TOLERANCE = 0.01;

/**
 * Turn the rectangles the browser measured for a selection into geometry the page can store.
 *
 * `rects` are in the rendered page's own coordinates: pixels from its top-left corner, at the
 * current zoom and rotation. What comes back is in unrotated page coordinates at zoom 1, which is
 * the space every stored overlay lives in — so the same selection measured at 100% and at 200%, or
 * before and after a quarter turn, produces the same annotation.
 */
export function textSelectionGeometry(
  rects: readonly LayerRect[],
  view: PageView,
): TextSelectionOverlayGeometry | null {
  const pageRects: OverlayRect[] = [];

  for (const rect of rects) {
    // Clipped first, in the space the measurement was taken in. A rectangle reaching past the page
    // would otherwise paint over the next page in a scrolling view, and one entirely outside is
    // discarded rather than kept as a sliver on the border.
    const clipped = clipRectToLayer(rect, view.width, view.height);
    if (clipped === null) continue;

    const pageRect = viewRectToPageRect(clipped, view);
    if (pageRect.width <= 0 || pageRect.height <= 0) continue;
    if (pageRects.some((existing) => isSameRect(existing, pageRect))) continue;
    pageRects.push(pageRect);
  }

  if (pageRects.length === 0) return null;

  const bounds = enclosingRect(pageRects);
  return {
    shape: "textSelection",
    bounds,
    fragments: pageRects.map((rect) => ({
      x: rect.x - bounds.x,
      y: rect.y - bounds.y,
      width: rect.width,
      height: rect.height,
    })),
  };
}

/** Which of the two shapes a stored overlay has. The only place that decision is made. */
export function overlayGeometry(overlay: OverlayItem): OverlayGeometry {
  const bounds: OverlayRect = {
    x: overlay.x,
    y: overlay.y,
    width: overlay.width,
    height: overlay.height,
  };

  if (overlay.fragments === undefined || overlay.fragments.length === 0) {
    return { shape: "box", bounds };
  }

  return { shape: "textSelection", bounds, fragments: overlay.fragments.map((rect) => ({ ...rect })) };
}

/**
 * The rectangles this overlay actually covers, in page coordinates.
 *
 * One for a box; one per line for a text selection. Every caller that paints, bakes or exports an
 * overlay's area goes through here, so none of them can reach for the enclosing box by habit.
 */
export function paintedPageRects(geometry: OverlayGeometry): OverlayRect[] {
  if (geometry.shape === "box") return [{ ...geometry.bounds }];

  return geometry.fragments.map((fragment) => ({
    x: geometry.bounds.x + fragment.x,
    y: geometry.bounds.y + fragment.y,
    width: fragment.width,
    height: fragment.height,
  }));
}

/**
 * Scale a selection's fragments with its bounds, so a resize moves the whole group together.
 *
 * A factor that cannot be computed — a zero starting width, an empty box — leaves the fragments
 * as they are rather than collapsing them to nothing.
 */
export function scaleSelectionFragments(
  fragments: readonly OverlayRect[],
  scaleX: number,
  scaleY: number,
): OverlayRect[] {
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY)) {
    return fragments.map((fragment) => ({ ...fragment }));
  }

  return fragments.map((fragment) => ({
    x: fragment.x * scaleX,
    y: fragment.y * scaleY,
    width: fragment.width * scaleX,
    height: fragment.height * scaleY,
  }));
}

/** The smallest rectangle containing all of them. */
export function enclosingRect(rects: readonly OverlayRect[]): OverlayRect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Rotation as one of the four quarter turns, whatever sign or multiple it arrived as. */
export function normalizeRotation(rotation: number): number {
  return ((rotation % 360) + 360) % 360;
}

/**
 * A point in the rotated page view, expressed on the upright page.
 *
 * The inverse of the transform the overlay layer is drawn with, so a measurement taken from the
 * screen can be stored in the coordinates the document uses.
 */
export function viewPointToUnrotated(
  vx: number,
  vy: number,
  rotation: number,
  viewWidth: number,
  viewHeight: number,
): { x: number; y: number } {
  switch (normalizeRotation(rotation)) {
    case 90:
      return { x: vy, y: viewWidth - vx };
    case 180:
      return { x: viewWidth - vx, y: viewHeight - vy };
    case 270:
      return { x: viewHeight - vy, y: vx };
    default:
      return { x: vx, y: vy };
  }
}

function viewRectToPageRect(rect: LayerRect, view: PageView): OverlayRect {
  const start = viewPointToUnrotated(rect.left, rect.top, view.rotation, view.width, view.height);
  const end = viewPointToUnrotated(
    rect.left + rect.width,
    rect.top + rect.height,
    view.rotation,
    view.width,
    view.height,
  );

  return {
    x: Math.min(start.x, end.x) / view.zoom,
    y: Math.min(start.y, end.y) / view.zoom,
    width: Math.abs(end.x - start.x) / view.zoom,
    height: Math.abs(end.y - start.y) / view.zoom,
  };
}

function isSameRect(a: OverlayRect, b: OverlayRect): boolean {
  return (
    Math.abs(a.x - b.x) <= DUPLICATE_TOLERANCE &&
    Math.abs(a.y - b.y) <= DUPLICATE_TOLERANCE &&
    Math.abs(a.width - b.width) <= DUPLICATE_TOLERANCE &&
    Math.abs(a.height - b.height) <= DUPLICATE_TOLERANCE
  );
}
