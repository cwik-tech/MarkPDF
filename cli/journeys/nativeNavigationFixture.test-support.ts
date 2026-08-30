import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  PDFPage,
  PDFString,
  StandardFonts,
} from "pdf-lib";

/**
 * A four-page tagged document whose text lives inside marked content and whose contents page
 * carries real `/Link` annotations.
 *
 * Built to be hostile to the two defects it exists to catch, in ways an ordinary fixture is not:
 *
 * - **Every visible run is wrapped in `BDC … EMC`.** PDF.js then reports `beginMarkedContentProps`
 *   for each run, and the text layer nests every glyph span inside a `.markedContent` wrapper. An
 *   untagged fixture renders leaf spans directly under the layer and cannot observe the wrapper
 *   defect at all.
 * - **Nothing worth finding sits near the page origin.** The searched word is drawn twice on page 2,
 *   far apart and far down the page, so a highlight that collapses to the top-left corner is
 *   separated from a correct one by hundreds of pixels rather than by rounding.
 * - **The contents page mixes links that must work with links that must not.** One explicit
 *   destination, one named destination, one external URL, one link whose rectangle is malformed, and
 *   one annotation that is not a link at all.
 *
 * Every expectation is a property of this builder, declared in `NATIVE_NAVIGATION` below and never
 * copied back from what a renderer produced.
 */

/** Page geometry, in PDF points. Several expectations are positions inside this box. */
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

/** Body size for the rows and paragraphs whose positions are asserted. */
const BODY_SIZE = 14;

/**
 * What this document contains, stated before anything renders it.
 *
 * Frozen so a test cannot quietly adjust an expectation to match a result.
 */
export const NATIVE_NAVIGATION = Object.freeze({
  pageCount: 4,
  pageWidth: PAGE_WIDTH,
  pageHeight: PAGE_HEIGHT,
  bodySize: BODY_SIZE,

  /** The contents page, and the only page carrying annotations. */
  contentsPage: 1,

  /**
   * The word drawn twice on page 2, at two widely separated heights.
   *
   * Chosen to appear nowhere else in the document, so a search for it has exactly two matches and
   * previous/next navigation has exactly one other occurrence to move to.
   */
  repeated: Object.freeze({
    page: 2,
    word: "Stewardship",
    /** The x of both lines, and the baseline y of each, in PDF points. */
    x: 72,
    firstBaselineY: 640,
    secondBaselineY: 300,
    firstLine: "Stewardship begins with accountable ownership of every record.",
    secondLine: "Stewardship ends with measured outcomes reported to the board.",
  }),

  /** The contents row whose link carries an explicit destination. */
  explicitRow: Object.freeze({
    text: "Chapter 2 Data Management Frameworks",
    destinationPage: 2,
    /** The annotation rectangle, in PDF points: [x0, y0, x1, y1]. */
    rect: Object.freeze([72, 634, 420, 660] as const),
  }),

  /** The contents row whose link carries a named destination resolved through the name tree. */
  namedRow: Object.freeze({
    text: "Chapter 3 Governance Reference Model",
    destinationName: "governance-reference-model",
    destinationPage: 3,
    rect: Object.freeze([72, 594, 420, 620] as const),
  }),

  /** A link to the web. Out of scope by decision: it must produce no interactive element. */
  externalRow: Object.freeze({
    text: "External reference site",
    url: "https://example.invalid/reference",
    rect: Object.freeze([72, 554, 420, 580] as const),
  }),

  /** A link whose rectangle has two numbers instead of four. It must produce no element. */
  malformedRow: Object.freeze({ text: "Damaged contents row" }),

  /** A non-link annotation over visible text. It must produce no element. */
  squareRow: Object.freeze({ text: "Annotated but not linked" }),

  /** How many link hitboxes the contents page must end up with. */
  expectedLinkCount: 2,

  /** Headings, so a destination page can be recognised by what it says. */
  headings: Object.freeze({
    page2: "Data Management Frameworks",
    page3: "Governance Reference Model",
    page4: "Appendix A Retention Schedule",
  }),
});

/**
 * Where a drawn line's glyph box lands on screen, in CSS pixels from the page's top-left corner.
 *
 * The independent expected result for a highlight's position: derived from the coordinates this
 * builder drew at and the viewport scale, never from anything the renderer measured. PDF y counts
 * up from the bottom and names a baseline; CSS y counts down from the top and names a box top, so
 * the height of the text is subtracted once.
 */
export function expectedGlyphBox(
  baselineY: number,
  x: number,
  zoom: number,
): { left: number; top: number } {
  return { left: x * zoom, top: (PAGE_HEIGHT - baselineY - BODY_SIZE) * zoom };
}

/**
 * Build the document.
 *
 * `pushOperators` and `drawText` append to the same content stream in call order, so wrapping a
 * draw between `BDC` and `EMC` puts that run inside a marked-content sequence — which is what makes
 * PDF.js emit a wrapper for it.
 */
export async function buildNativeNavigationPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const contents = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const chapterTwo = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const chapterThree = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const appendix = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

  let markedContentId = 0;
  /**
   * Draw inside a marked-content sequence, the way a tagged document does.
   *
   * The properties operand is written as an inline dictionary literal. `pushOperators` copies a
   * string operand into the content stream verbatim, and an inline `<< /MCID n >>` is what a tagged
   * PDF actually carries — a `PDFDict` is not one of the operand types the library accepts.
   */
  const tagged = (page: PDFPage, draw: () => void): void => {
    const properties = `<< /MCID ${markedContentId} >>`;
    markedContentId += 1;
    page.pushOperators(
      PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of("P"), properties]),
    );
    draw();
    page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
  };

  tagged(contents, () =>
    contents.drawText("Table of contents", { x: 72, y: 720, size: 20, font: bold }),
  );
  tagged(contents, () =>
    contents.drawText(NATIVE_NAVIGATION.explicitRow.text, { x: 72, y: 640, size: BODY_SIZE, font }),
  );
  tagged(contents, () =>
    contents.drawText(NATIVE_NAVIGATION.namedRow.text, { x: 72, y: 600, size: BODY_SIZE, font }),
  );
  tagged(contents, () =>
    contents.drawText(NATIVE_NAVIGATION.externalRow.text, { x: 72, y: 560, size: BODY_SIZE, font }),
  );
  tagged(contents, () =>
    contents.drawText(NATIVE_NAVIGATION.malformedRow.text, { x: 72, y: 520, size: BODY_SIZE, font }),
  );
  tagged(contents, () =>
    contents.drawText(NATIVE_NAVIGATION.squareRow.text, { x: 72, y: 480, size: BODY_SIZE, font }),
  );

  tagged(chapterTwo, () =>
    chapterTwo.drawText(NATIVE_NAVIGATION.headings.page2, { x: 72, y: 720, size: 18, font: bold }),
  );
  tagged(chapterTwo, () =>
    chapterTwo.drawText(NATIVE_NAVIGATION.repeated.firstLine, {
      x: NATIVE_NAVIGATION.repeated.x,
      y: NATIVE_NAVIGATION.repeated.firstBaselineY,
      size: BODY_SIZE,
      font,
    }),
  );
  // Filler between the two occurrences, so nothing but position distinguishes them.
  tagged(chapterTwo, () =>
    chapterTwo.drawText("Accountability for each record is recorded in the register.", {
      x: 72,
      y: 470,
      size: BODY_SIZE,
      font,
    }),
  );
  tagged(chapterTwo, () =>
    chapterTwo.drawText(NATIVE_NAVIGATION.repeated.secondLine, {
      x: NATIVE_NAVIGATION.repeated.x,
      y: NATIVE_NAVIGATION.repeated.secondBaselineY,
      size: BODY_SIZE,
      font,
    }),
  );

  tagged(chapterThree, () =>
    chapterThree.drawText(NATIVE_NAVIGATION.headings.page3, { x: 72, y: 720, size: 18, font: bold }),
  );
  tagged(chapterThree, () =>
    chapterThree.drawText("Roles, decision rights and escalation paths are listed here.", {
      x: 72,
      y: 660,
      size: BODY_SIZE,
      font,
    }),
  );

  tagged(appendix, () =>
    appendix.drawText(NATIVE_NAVIGATION.headings.page4, { x: 72, y: 720, size: 18, font: bold }),
  );

  // The named destination, in the catalogue's name tree — the form a real book uses.
  const namedDestination = pdf.context.obj([
    chapterThree.ref,
    PDFName.of("XYZ"),
    PDFNumber.of(0),
    PDFNumber.of(PAGE_HEIGHT),
    PDFNumber.of(0),
  ]);
  const destinations = pdf.context.obj({
    Names: pdf.context.obj([
      PDFString.of(NATIVE_NAVIGATION.namedRow.destinationName),
      namedDestination,
    ]),
  });
  pdf.catalog.set(
    PDFName.of("Names"),
    pdf.context.register(pdf.context.obj({ Dests: pdf.context.register(destinations) })),
  );

  const explicitLink = pdf.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Link"),
    Rect: pdf.context.obj([...NATIVE_NAVIGATION.explicitRow.rect]),
    Border: pdf.context.obj([0, 0, 0]),
    A: pdf.context.obj({
      S: PDFName.of("GoTo"),
      D: pdf.context.obj([
        chapterTwo.ref,
        PDFName.of("XYZ"),
        PDFNumber.of(0),
        PDFNumber.of(PAGE_HEIGHT),
        PDFNumber.of(0),
      ]),
    }),
  });

  const namedLink = pdf.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Link"),
    Rect: pdf.context.obj([...NATIVE_NAVIGATION.namedRow.rect]),
    Border: pdf.context.obj([0, 0, 0]),
    A: pdf.context.obj({
      S: PDFName.of("GoTo"),
      D: PDFString.of(NATIVE_NAVIGATION.namedRow.destinationName),
    }),
  });

  const externalLink = pdf.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Link"),
    Rect: pdf.context.obj([...NATIVE_NAVIGATION.externalRow.rect]),
    A: pdf.context.obj({
      S: PDFName.of("URI"),
      URI: PDFString.of(NATIVE_NAVIGATION.externalRow.url),
    }),
  });

  // Two numbers where four belong. PDF.js normalises this to a zero-area rectangle rather than
  // refusing the annotation, so the renderer is the layer that has to notice.
  const malformedLink = pdf.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Link"),
    Rect: pdf.context.obj([72, 514]),
    Dest: pdf.context.obj([appendix.ref, PDFName.of("Fit")]),
  });

  const squareAnnotation = pdf.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Square"),
    Rect: pdf.context.obj([72, 474, 420, 500]),
  });

  contents.node.set(
    PDFName.of("Annots"),
    pdf.context.obj(
      [explicitLink, namedLink, externalLink, malformedLink, squareAnnotation].map((annotation) =>
        pdf.context.register(annotation),
      ),
    ),
  );

  return pdf.save();
}
