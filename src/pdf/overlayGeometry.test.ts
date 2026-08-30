import { describe, expect, it } from "vitest";
import type { OverlayItem } from "../types";
import {
  overlayGeometry,
  paintedPageRects,
  scaleSelectionFragments,
  textSelectionGeometry,
  type PageView,
} from "./overlayGeometry";

/**
 * The arithmetic that turns what the browser measured into what the page stores.
 *
 * Deliberately not the measuring: which rectangles `Range.getClientRects` returns for a real
 * selection is a layout question only a rendered page can answer, and it is covered by
 * `tests/e2e/text-selection-annotations.spec.ts`. What lives here is everything that happens to
 * those rectangles afterwards, where a wrong answer paints the highlight in the wrong place at
 * some zoom or rotation the acceptance journey never visits.
 */

/** An unrotated page at its natural size, which is the simplest case to reason about. */
const UPRIGHT: PageView = { width: 612, height: 792, rotation: 0, zoom: 1 };

/**
 * Two drawn lines with a 42-pixel band between them, as the browser reports them.
 *
 * The second line is shorter than the first, so a result that reused one width for both would be
 * visible rather than coincidentally right.
 */
const TWO_LINES = [
  { left: 72, top: 80, width: 150, height: 18 },
  { left: 72, top: 140, width: 130, height: 18 },
];

function makeOverlay(overrides: Partial<OverlayItem> = {}): OverlayItem {
  return {
    id: "overlay-1",
    kind: "highlight",
    page: 1,
    x: 72,
    y: 80,
    width: 150,
    height: 78,
    color: "#facc15",
    ...overrides,
  };
}

describe("turning a measured text selection into page geometry", () => {
  it("keeps one fragment per measured rectangle instead of one box over all of them", () => {
    const geometry = textSelectionGeometry(TWO_LINES, UPRIGHT);

    expect(geometry).not.toBeNull();
    expect(geometry?.shape).toBe("textSelection");
    expect(geometry?.fragments).toEqual([
      { x: 0, y: 0, width: 150, height: 18 },
      { x: 0, y: 60, width: 130, height: 18 },
    ]);
  });

  it("reports outer bounds that enclose every fragment", () => {
    // The lines span 72..222 across and 80..158 down, so the enclosing box is 150 by 78.
    expect(textSelectionGeometry(TWO_LINES, UPRIGHT)?.bounds).toEqual({
      x: 72,
      y: 80,
      width: 150,
      height: 78,
    });
  });

  it("leaves the band between two lines outside every fragment", () => {
    // The requirement stated as arithmetic: the midpoint of the 42-pixel band, 118 down the page,
    // is inside the bounds and inside none of the fragments.
    const geometry = textSelectionGeometry(TWO_LINES, UPRIGHT);
    const bandMidpoint = 119;

    const painted = paintedPageRects(geometry!);
    expect(painted.some((rect) => bandMidpoint >= rect.y && bandMidpoint <= rect.y + rect.height)).toBe(
      false,
    );
    expect(geometry!.bounds.y).toBeLessThan(bandMidpoint);
    expect(geometry!.bounds.y + geometry!.bounds.height).toBeGreaterThan(bandMidpoint);
  });

  it("records the same page geometry whatever zoom the reader measured it at", () => {
    // The same two lines on a page drawn at 200%: every measurement doubles, and the stored
    // geometry must not, or the highlight would land twice as far down the page when reopened.
    const doubled = TWO_LINES.map((rect) => ({
      left: rect.left * 2,
      top: rect.top * 2,
      width: rect.width * 2,
      height: rect.height * 2,
    }));

    expect(
      textSelectionGeometry(doubled, { width: 1224, height: 1584, rotation: 0, zoom: 2 }),
    ).toEqual(textSelectionGeometry(TWO_LINES, UPRIGHT));
  });

  it("stores a selection made on a rotated page in unrotated page coordinates", () => {
    // A quarter turn puts the 612 by 792 page on its side, so a line of text is a tall strip on
    // screen. Its corners at (100, 50) and (120, 170) unrotate to (50, 692) and (170, 672), which
    // is a 120 by 20 horizontal strip on the upright page.
    const geometry = textSelectionGeometry([{ left: 100, top: 50, width: 20, height: 120 }], {
      width: 792,
      height: 612,
      rotation: 90,
      zoom: 1,
    });

    expect(geometry?.bounds).toEqual({ x: 50, y: 672, width: 120, height: 20 });
    expect(geometry?.fragments).toEqual([{ x: 0, y: 0, width: 120, height: 20 }]);
  });

  it("keeps one fragment when the browser reports the same rectangle twice", () => {
    // A range that crosses a wrapper element is reported once for the wrapper and once for the run
    // inside it. Painting both stacks two translucent layers and doubles the colour.
    const geometry = textSelectionGeometry([TWO_LINES[0], { ...TWO_LINES[0] }], UPRIGHT);

    expect(geometry?.fragments).toEqual([{ x: 0, y: 0, width: 150, height: 18 }]);
  });

  it("drops a rectangle with no area rather than painting a hairline", () => {
    const geometry = textSelectionGeometry(
      [TWO_LINES[0], { left: 72, top: 200, width: 0, height: 18 }, { left: 72, top: 220, width: 40, height: 0 }],
      UPRIGHT,
    );

    expect(geometry?.fragments).toEqual([{ x: 0, y: 0, width: 150, height: 18 }]);
  });

  it("clips a fragment that reaches past the page edge back onto the page", () => {
    const geometry = textSelectionGeometry([{ left: -20, top: 80, width: 60, height: 18 }], UPRIGHT);

    expect(geometry?.bounds).toEqual({ x: 0, y: 80, width: 40, height: 18 });
  });

  it("reports nothing when every measured rectangle is off the page", () => {
    expect(textSelectionGeometry([{ left: 700, top: 80, width: 60, height: 18 }], UPRIGHT)).toBeNull();
    expect(textSelectionGeometry([], UPRIGHT)).toBeNull();
  });
});

describe("reading the geometry a stored overlay describes", () => {
  it("treats an overlay with no fragments as the single box it has always been", () => {
    const geometry = overlayGeometry(makeOverlay({ x: 40, y: 50, width: 180, height: 28 }));

    expect(geometry).toEqual({
      shape: "box",
      bounds: { x: 40, y: 50, width: 180, height: 28 },
    });
  });

  it("treats an overlay carrying fragments as a text selection", () => {
    const geometry = overlayGeometry(
      makeOverlay({ fragments: [{ x: 0, y: 0, width: 150, height: 18 }] }),
    );

    expect(geometry.shape).toBe("textSelection");
  });

  it("paints a box overlay as its own rectangle", () => {
    expect(paintedPageRects(overlayGeometry(makeOverlay()))).toEqual([
      { x: 72, y: 80, width: 150, height: 78 },
    ]);
  });

  it("paints a text selection as its fragments, placed against the page", () => {
    // Fragments are stored relative to the overlay's own corner so that dragging the overlay moves
    // them with it. On the page they sit at 72,80 and 72,140 — the lines that were selected.
    const overlay = makeOverlay({
      fragments: [
        { x: 0, y: 0, width: 150, height: 18 },
        { x: 0, y: 60, width: 130, height: 18 },
      ],
    });

    expect(paintedPageRects(overlayGeometry(overlay))).toEqual([
      { x: 72, y: 80, width: 150, height: 18 },
      { x: 72, y: 140, width: 130, height: 18 },
    ]);
  });
});

describe("resizing a text-selection overlay as a group", () => {
  it("scales every fragment by the same factors as the outer bounds", () => {
    expect(
      scaleSelectionFragments(
        [
          { x: 0, y: 0, width: 150, height: 18 },
          { x: 0, y: 60, width: 130, height: 18 },
        ],
        2,
        0.5,
      ),
    ).toEqual([
      { x: 0, y: 0, width: 300, height: 9 },
      { x: 0, y: 30, width: 260, height: 9 },
    ]);
  });

  it("leaves fragments alone when the factors cannot be computed", () => {
    const fragments = [{ x: 0, y: 0, width: 150, height: 18 }];
    expect(scaleSelectionFragments(fragments, Number.POSITIVE_INFINITY, 1)).toEqual(fragments);
    expect(scaleSelectionFragments(fragments, Number.NaN, 1)).toEqual(fragments);
  });
});
