import { describe, expect, it } from "vitest";
import {
  clipLinkBox,
  parseInternalLinkAnnotations,
  resolveInternalDestinationPage,
  type DestinationResolver,
  type InternalDestination,
} from "./internalLinks";

/**
 * The boundary between a PDF's own annotation data and something the reader can click.
 *
 * Annotations are external input: they come from a file anybody can produce, and PDF.js hands them
 * over with whatever the file said in them. Everything below therefore starts from `unknown` and
 * states what is admitted rather than what is rejected — a link that is not an internal destination,
 * or whose rectangle is not a rectangle, must produce nothing at all rather than an element sitting
 * in a corner of the page waiting to be clicked.
 */

/** A link annotation as PDF.js reports one, with only the fields this boundary reads. */
function makeAnnotation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subtype: "Link",
    rect: [72, 634, 420, 660],
    dest: [{ num: 7, gen: 0 }, { name: "XYZ" }, 0, 792, 0],
    ...overrides,
  };
}

describe("admitting the annotations a reader may follow", () => {
  it("accepts a link whose destination is an explicit page reference", () => {
    const [link] = parseInternalLinkAnnotations([makeAnnotation()]);
    expect(link?.rect).toEqual([72, 634, 420, 660]);
    expect(link?.destination).toEqual({ kind: "pageReference", ref: { num: 7, gen: 0 } });
  });

  it("accepts a link whose destination is a name in the catalogue", () => {
    const [link] = parseInternalLinkAnnotations([
      makeAnnotation({ dest: "governance-reference-model" }),
    ]);
    expect(link?.destination).toEqual({ kind: "named", name: "governance-reference-model" });
  });

  it("puts a rectangle's corners in order, whichever way round the file wrote them", () => {
    // PDF rectangles are two opposite corners and carry no promise about which is which.
    const [link] = parseInternalLinkAnnotations([makeAnnotation({ rect: [420, 660, 72, 634] })]);
    expect(link?.rect).toEqual([72, 634, 420, 660]);
  });

  it("refuses a link to the web, which needs a decision this boundary is not allowed to make", () => {
    expect(
      parseInternalLinkAnnotations([
        { subtype: "Link", rect: [72, 554, 420, 580], url: "https://example.invalid/reference" },
      ]),
    ).toEqual([]);
  });

  it("refuses a link that carries both a destination and a URL rather than guessing", () => {
    expect(
      parseInternalLinkAnnotations([makeAnnotation({ url: "https://example.invalid/reference" })]),
    ).toEqual([]);
  });

  it("refuses a link that also carries an action, whatever else it says", () => {
    // An annotation that both goes somewhere and does something is not a plain internal link, and
    // this boundary is not the place to decide which half wins. PDF.js reports each kind of action
    // it understands under its own field; any of them present means the annotation does more than
    // move the reader, so none of them is followed here.
    for (const action of [
      { action: "NextPage" },
      { resetForm: { fields: [], refs: [], include: true } },
      { setOCGState: { state: [], preserveRB: true } },
      { attachment: { filename: "notes.txt" } },
    ]) {
      expect(parseInternalLinkAnnotations([makeAnnotation(action)]), JSON.stringify(action)).toEqual([]);
    }
  });

  it("refuses an annotation that is not a link", () => {
    expect(parseInternalLinkAnnotations([makeAnnotation({ subtype: "Square" })])).toEqual([]);
    expect(parseInternalLinkAnnotations([makeAnnotation({ subtype: undefined })])).toEqual([]);
  });

  it("refuses a rectangle that is not four usable numbers", () => {
    for (const rect of [[72, 634], [72, 634, 420, 660, 12], "72 634 420 660", null, [72, 634, 420, Number.NaN], [72, 634, 420, Number.POSITIVE_INFINITY]]) {
      expect(parseInternalLinkAnnotations([makeAnnotation({ rect })]), JSON.stringify(rect)).toEqual([]);
    }
  });

  it("refuses a rectangle with no area, which is what a malformed one becomes", () => {
    // PDF.js normalises a `/Rect` with the wrong number of entries to `[0, 0, 0, 0]` rather than
    // dropping the annotation, so a zero-area box is the shape a damaged file actually produces.
    expect(parseInternalLinkAnnotations([makeAnnotation({ rect: [0, 0, 0, 0] })])).toEqual([]);
    expect(parseInternalLinkAnnotations([makeAnnotation({ rect: [72, 634, 72, 660] })])).toEqual([]);
  });

  it("accepts a destination that names a page by its position in the document", () => {
    // The other explicit form the installed PDF.js admits: a zero-based page index instead of an
    // object reference (`_isValidExplicitDest` accepts `Number.isInteger(page)`, and the library's
    // own viewer follows it as `destRef + 1`). A file that uses it is not malformed, and refusing
    // it would leave a working contents page dead.
    const [link] = parseInternalLinkAnnotations([
      makeAnnotation({ dest: [2, { name: "Fit" }] }),
    ]);
    expect(link?.destination).toEqual({ kind: "pageIndex", index: 2 });
  });

  it("refuses a destination that names no page", () => {
    for (const dest of [[], [{ num: "7", gen: 0 }], [{ num: 7 }], [{ num: -1, gen: 0 }], [{ num: 1.5, gen: 0 }], [-1], [1.5], [Number.NaN], ["2"], "", 7, null, undefined]) {
      expect(parseInternalLinkAnnotations([makeAnnotation({ dest })]), JSON.stringify(dest)).toEqual([]);
    }
  });

  it("refuses anything that is not a list of annotation objects", () => {
    expect(parseInternalLinkAnnotations(null)).toEqual([]);
    expect(parseInternalLinkAnnotations("annotations")).toEqual([]);
    expect(parseInternalLinkAnnotations([null, 7, "link"])).toEqual([]);
  });

  it("keeps the good annotations from a page that also carries bad ones", () => {
    const links = parseInternalLinkAnnotations([
      makeAnnotation({ subtype: "Square" }),
      makeAnnotation({ dest: "governance-reference-model" }),
      makeAnnotation({ rect: [0, 0, 0, 0] }),
      makeAnnotation(),
    ]);
    expect(links.map((link) => link.destination.kind)).toEqual(["named", "pageReference"]);
  });
});

/** A document that knows three pages and one name, and complains about anything else. */
function makeResolver(overrides: Partial<DestinationResolver> = {}): DestinationResolver {
  return {
    numPages: 4,
    getDestination: async (id) =>
      id === "governance-reference-model" ? [{ num: 8, gen: 0 }, { name: "XYZ" }, 0, 792, 0] : null,
    getPageIndex: async (ref) => {
      if (ref.num === 7) return 1;
      if (ref.num === 8) return 2;
      throw new Error(`No page for reference ${ref.num}.`);
    },
    ...overrides,
  };
}

describe("turning a destination into a page of this document", () => {
  const explicit: InternalDestination = { kind: "pageReference", ref: { num: 7, gen: 0 } };
  const named: InternalDestination = { kind: "named", name: "governance-reference-model" };
  const byIndex: InternalDestination = { kind: "pageIndex", index: 2 };

  it("resolves an explicit reference to a one-based page", async () => {
    expect(await resolveInternalDestinationPage(makeResolver(), explicit)).toBe(2);
  });

  it("resolves a name through the catalogue and then to a one-based page", async () => {
    expect(await resolveInternalDestinationPage(makeResolver(), named)).toBe(3);
  });

  it("resolves a page index to the one-based page it counts to", async () => {
    expect(await resolveInternalDestinationPage(makeResolver(), byIndex)).toBe(3);
  });

  it("resolves a name whose destination counts a page rather than referencing one", async () => {
    const resolver = makeResolver({ getDestination: async () => [1, { name: "Fit" }] });
    expect(await resolveInternalDestinationPage(resolver, named)).toBe(2);
  });

  it("refuses a page index past the end of this document", async () => {
    expect(
      await resolveInternalDestinationPage(makeResolver(), { kind: "pageIndex", index: 4 }),
    ).toBeNull();
  });

  it("gives up on a name the document does not have", async () => {
    expect(
      await resolveInternalDestinationPage(makeResolver(), { kind: "named", name: "missing" }),
    ).toBeNull();
  });

  it("gives up when a name resolves to something that is not a destination", async () => {
    const resolver = makeResolver({ getDestination: async () => ["not a page reference"] });
    expect(await resolveInternalDestinationPage(resolver, named)).toBeNull();
  });

  it("gives up on a page outside this document rather than moving the reader nowhere", async () => {
    // A page index the document cannot have means the file and the resolver disagree. Sending the
    // reader to page 99 of a four-page book is worse than not moving at all.
    const resolver = makeResolver({ getPageIndex: async () => 98 });
    expect(await resolveInternalDestinationPage(resolver, explicit)).toBeNull();
  });

  it("gives up when the resolver refuses", async () => {
    const resolver = makeResolver({
      getPageIndex: async () => {
        throw new Error("unresolved reference");
      },
    });
    expect(await resolveInternalDestinationPage(resolver, explicit)).toBeNull();
  });

  it("gives up on a page index that is not a whole number", async () => {
    const resolver = makeResolver({ getPageIndex: async () => Number.NaN });
    expect(await resolveInternalDestinationPage(resolver, explicit)).toBeNull();
  });
});

describe("placing a link's box in the rendered page", () => {
  const view = { width: 612, height: 792 };

  it("orders the corners the viewport transform produced", () => {
    // `convertToViewportRectangle` flips the y axis, and on a rotated page it swaps the axes too,
    // so the corners it returns are not in ascending order.
    expect(clipLinkBox([420, 158, 72, 132], view)).toEqual({
      left: 72,
      top: 132,
      width: 348,
      height: 26,
    });
  });

  it("clips a box that reaches past the page it is drawn on", () => {
    // The page box does not clip its own children, so a link rectangle wider than the page would
    // put a clickable area over whatever is beside it — the next page, or the sidebar.
    expect(clipLinkBox([500, 700, 900, 900], view)).toEqual({
      left: 500,
      top: 700,
      width: 112,
      height: 92,
    });
  });

  it("drops a box that is entirely off the page", () => {
    expect(clipLinkBox([700, 100, 900, 140], view)).toBeNull();
    expect(clipLinkBox([-400, 100, -100, 140], view)).toBeNull();
  });

  it("drops a box with no area once it has been placed", () => {
    expect(clipLinkBox([100, 100, 100, 140], view)).toBeNull();
  });
});
