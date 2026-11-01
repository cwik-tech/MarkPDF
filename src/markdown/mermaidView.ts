/**
 * Rules for the controls on a rendered Mermaid diagram. The component that draws the diagram
 * lives in `MermaidDiagram.tsx`; this module holds the parts that do not need a DOM.
 *
 * A diagram's zoom is relative to its fitted size: 100% is the chart as the frame shows it
 * without help, which is its own width or the frame's width, whichever is smaller. So the first
 * click always makes the chart a quarter larger than what the reader is looking at, whether the
 * frame had to shrink it or not.
 */

/** The levels the zoom buttons move between, as multiples of the fitted size. */
export const DIAGRAM_ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;

const MIN_ZOOM = DIAGRAM_ZOOM_STEPS[0];
const MAX_ZOOM = DIAGRAM_ZOOM_STEPS[DIAGRAM_ZOOM_STEPS.length - 1];

/** The next step up or down from `zoom`, or the end of the range when there is none. */
export function stepDiagramZoom(zoom: number, direction: 1 | -1): number {
  if (direction === 1) {
    return DIAGRAM_ZOOM_STEPS.find((step) => step > zoom) ?? MAX_ZOOM;
  }
  for (let index = DIAGRAM_ZOOM_STEPS.length - 1; index >= 0; index -= 1) {
    const step = DIAGRAM_ZOOM_STEPS[index];
    if (step < zoom) return step;
  }
  return MIN_ZOOM;
}

export function diagramZoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/** A length in CSS pixels, written either as a bare number or with `px`. */
function pixels(value: string | null, allowBare: boolean): number | null {
  if (value === null) return null;
  const match = allowBare
    ? /^\s*(\d+(?:\.\d+)?)(px)?\s*$/.exec(value)
    : /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(value);
  if (!match) return null;
  const length = Number(match[1]);
  return Number.isFinite(length) && length > 0 ? length : null;
}

/**
 * How wide a rendered chart is at its own size, in CSS pixels, or null when it does not say.
 *
 * Mermaid writes this in one of three places. A chart that scales to its container gets
 * `width="100%"` and an inline `max-width` with its real width; a chart that does not gets a
 * fixed `width`. Nearly every chart also has a view box. They are read in that order.
 */
export function svgNaturalWidth(sizes: {
  maxWidth: string;
  viewBox: string | null;
  width: string | null;
}): number | null {
  const fromMaxWidth = pixels(sizes.maxWidth, false);
  if (fromMaxWidth !== null) return fromMaxWidth;

  const box = sizes.viewBox?.trim().split(/[\s,]+/) ?? [];
  if (box.length === 4) {
    const boxWidth = Number(box[2]);
    if (Number.isFinite(boxWidth) && boxWidth > 0) return boxWidth;
  }

  return pixels(sizes.width, true);
}

/** The file name the save dialog offers, from the document's name and the diagram's position. */
export function diagramFileName(documentName: string | undefined, diagramNumber: number): string {
  const name = documentName?.trim() ?? "";
  const stem = name.replace(/\.[^.]+$/, "");
  const suffix = `diagram-${diagramNumber}.svg`;
  return stem ? `${stem}-${suffix}` : suffix;
}
