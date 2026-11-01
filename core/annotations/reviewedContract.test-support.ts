import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts, rgb, type PDFFont } from "pdf-lib";

/**
 * A one-page contract with the three kinds of annotation a real reviewed document carries.
 *
 * - A reviewer's highlight with a note, written the way Acrobat writes one.
 * - The same reviewer's highlight with no note at all. It is still evidence of what they marked.
 * - A comment the person made in MarkPDF and saved, in MarkPDF's own two forms: the
 *   `markpdf-overlays:` keyword that carries the exact note, and the standard annotation MarkPDF
 *   writes beside it for other readers. A reader must report it once, not twice.
 *
 * The MarkPDF form is written here by hand rather than through the renderer's `exportPdfBytes`,
 * because core tests cannot import the renderer. `core/annotations/rendererParity.test.ts` proves
 * that the reader reads what `exportPdfBytes` really writes.
 *
 * Every expected value a test asserts is a constant below, never something read back from a
 * reader's output.
 */

export const REVIEWER = "Jane Reviewer, Counterparty LLP";
export const REVIEWER_NOTE = "Too short; we need 60 days.";
export const MARKPDF_NOTE = "Check this with finance.";
export const MARKPDF_COMMENT_ID = "comment-finance";

export const TEXT_LINES = {
  termination: "Termination requires thirty days notice",
  payment: "Payment is due within sixty days",
  notices: "Notices go to the registered address",
} as const;

export const PAGE_WIDTH = 612;
export const PAGE_HEIGHT = 792;
const FONT_SIZE = 14;
const LEFT = 72;
const BASELINES = { termination: 700, payment: 650, notices: 600 } as const;

/** The rectangle of one drawn line, in PDF space: measured from the bottom of the page. */
export function lineBox(font: PDFFont, line: keyof typeof TEXT_LINES): { left: number; bottom: number; right: number; top: number } {
  const baseline = BASELINES[line];
  return {
    left: LEFT,
    bottom: baseline - 3,
    right: LEFT + font.widthOfTextAtSize(TEXT_LINES[line], FONT_SIZE),
    top: baseline + 11,
  };
}

function quadPoints(box: { left: number; bottom: number; right: number; top: number }): number[] {
  return [box.left, box.top, box.right, box.top, box.left, box.bottom, box.right, box.bottom];
}

function encodeKeyword(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export async function buildReviewedContract(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  for (const line of Object.keys(TEXT_LINES) as Array<keyof typeof TEXT_LINES>) {
    page.drawText(TEXT_LINES[line], { x: LEFT, y: BASELINES[line], size: FONT_SIZE, font, color: rgb(0, 0, 0) });
  }

  const termination = lineBox(font, "termination");
  const payment = lineBox(font, "payment");
  const notices = lineBox(font, "notices");

  const withNote = pdf.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Highlight"),
    Rect: [termination.left, termination.bottom, termination.right, termination.top],
    QuadPoints: quadPoints(termination),
    Contents: PDFHexString.fromText(REVIEWER_NOTE),
    T: PDFHexString.fromText(REVIEWER),
    NM: PDFString.of("reviewer-1"),
    M: PDFString.of("D:20261030101200Z"),
    C: [1, 0.85, 0.2],
    F: 4,
  });
  const withoutNote = pdf.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Highlight"),
    Rect: [payment.left, payment.bottom, payment.right, payment.top],
    QuadPoints: quadPoints(payment),
    T: PDFHexString.fromText(REVIEWER),
    NM: PDFString.of("reviewer-2"),
    C: [1, 0.85, 0.2],
    F: 4,
  });
  // MarkPDF's standard copy of its own comment, as `writeMarkPdfAnnotations` writes it.
  const markpdfStandard = pdf.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Highlight"),
    Rect: [notices.left, notices.bottom, notices.right, notices.top],
    QuadPoints: quadPoints(notices),
    Contents: PDFString.of(MARKPDF_NOTE),
    T: PDFString.of("MarkPDF"),
    Subj: PDFString.of("Comment"),
    NM: PDFString.of(`markpdf:${MARKPDF_COMMENT_ID}`),
    C: [1, 0.88, 0.1],
    CA: 0.35,
    F: 4,
  });
  page.node.set(
    PDFName.of("Annots"),
    pdf.context.obj([
      pdf.context.register(withNote),
      pdf.context.register(withoutNote),
      pdf.context.register(markpdfStandard),
    ]),
  );

  // MarkPDF's keyword copy: page space measured from the top of the page, fragments as offsets.
  const top = PAGE_HEIGHT - notices.top;
  const height = notices.top - notices.bottom;
  const width = notices.right - notices.left;
  pdf.setKeywords([
    "contract",
    `markpdf-overlays:${encodeKeyword([
      {
        id: MARKPDF_COMMENT_ID,
        kind: "comment",
        page: 1,
        x: notices.left,
        y: top,
        width,
        height,
        text: MARKPDF_NOTE,
        fontSize: 12,
        color: "#facc15",
        minimized: true,
        fragments: [{ x: 0, y: 0, width, height }],
      },
    ])}`,
  ]);

  return await pdf.save();
}
