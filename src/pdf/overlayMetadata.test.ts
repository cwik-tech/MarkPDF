import { describe, expect, it } from "vitest";
import { parsePersistedOverlays } from "./overlayMetadata";

/**
 * Reading the annotations a saved document carries.
 *
 * The JSON comes out of a file that anything could have written — an older MarkPDF, a different
 * tool, a truncated save — so it is external input and gets checked field by field. The two cases
 * that matter to a reader are at the ends of that range: a document saved before text-anchored
 * annotations existed still opens with its highlights in the right place, and a document saved
 * with them keeps every line it was anchored to.
 */

/** A highlight as versions before text anchoring wrote it: one box, and no fragments field. */
const LEGACY_HIGHLIGHT = {
  id: "highlight-1",
  kind: "highlight",
  page: 2,
  x: 72,
  y: 80,
  width: 150,
  height: 78,
  color: "#facc15",
};

describe("reading overlays a saved document carries", () => {
  it("loads an overlay written before text anchoring as the single box it described", () => {
    expect(parsePersistedOverlays([LEGACY_HIGHLIGHT])).toEqual([LEGACY_HIGHLIGHT]);
  });

  it("keeps every fragment of an overlay anchored to selected text", () => {
    const anchored = {
      ...LEGACY_HIGHLIGHT,
      fragments: [
        { x: 0, y: 0, width: 150, height: 18 },
        { x: 0, y: 60, width: 130, height: 18 },
      ],
    };

    expect(parsePersistedOverlays([anchored])).toEqual([anchored]);
  });

  it("keeps a comment's own fields alongside its fragments", () => {
    const comment = {
      id: "comment-1",
      kind: "comment",
      page: 1,
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      text: "Check this against the plan",
      fontSize: 12,
      color: "#facc15",
      minimized: true,
      fragments: [{ x: 0, y: 0, width: 30, height: 12 }],
    };

    expect(parsePersistedOverlays([comment])).toEqual([comment]);
  });

  it("reads nothing at all from a value that is not a list of overlays", () => {
    expect(parsePersistedOverlays(null)).toEqual([]);
    expect(parsePersistedOverlays("markpdf")).toEqual([]);
    expect(parsePersistedOverlays({ overlays: [LEGACY_HIGHLIGHT] })).toEqual([]);
  });

  it("drops an entry that does not describe a placeable annotation", () => {
    expect(
      parsePersistedOverlays([
        { ...LEGACY_HIGHLIGHT, id: 7 },
        { ...LEGACY_HIGHLIGHT, kind: "sticker" },
        { ...LEGACY_HIGHLIGHT, page: 0 },
        { ...LEGACY_HIGHLIGHT, page: 1.5 },
        { ...LEGACY_HIGHLIGHT, x: Number.NaN },
        { ...LEGACY_HIGHLIGHT, height: "78" },
        null,
        "highlight",
      ]),
    ).toEqual([]);
  });

  it("keeps the overlays it can read when one entry beside them is unreadable", () => {
    expect(parsePersistedOverlays([{ ...LEGACY_HIGHLIGHT, kind: "sticker" }, LEGACY_HIGHLIGHT])).toEqual([
      LEGACY_HIGHLIGHT,
    ]);
  });

  it("ignores an optional field whose value is the wrong kind of thing", () => {
    expect(
      parsePersistedOverlays([
        { ...LEGACY_HIGHLIGHT, text: 42, fontSize: "12", color: null, minimized: "yes" },
      ]),
    ).toEqual([
      { id: "highlight-1", kind: "highlight", page: 2, x: 72, y: 80, width: 150, height: 78 },
    ]);
  });

  it("falls back to one box when the fragments it was given cannot be trusted", () => {
    // A fragment list that survived partially would paint some of the selected lines and silently
    // drop the rest, which looks like a highlight the reader never made. One box is the honest
    // reading of geometry this cannot verify.
    expect(
      parsePersistedOverlays([
        { ...LEGACY_HIGHLIGHT, fragments: "two lines" },
        { ...LEGACY_HIGHLIGHT, fragments: [] },
        { ...LEGACY_HIGHLIGHT, fragments: [{ x: 0, y: 0, width: 150 }] },
        { ...LEGACY_HIGHLIGHT, fragments: [{ x: 0, y: 0, width: 0, height: 18 }] },
        { ...LEGACY_HIGHLIGHT, fragments: [{ x: 0, y: 0, width: 150, height: 18 }, null] },
      ]),
    ).toEqual([
      LEGACY_HIGHLIGHT,
      LEGACY_HIGHLIGHT,
      LEGACY_HIGHLIGHT,
      LEGACY_HIGHLIGHT,
      LEGACY_HIGHLIGHT,
    ]);
  });
});
