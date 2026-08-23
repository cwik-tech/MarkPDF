import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * A three-page report whose page numbers are known before any extractor runs.
 *
 * Page 3 carries a decoy that names page 2 in prose, so an implementation returning the right
 * words from the wrong page fails rather than passes. The expected pages below are properties of
 * this builder, written down here and never copied back from extractor output.
 */
export const PAGE_ONE_SENTINEL = "Administrative preamble concerning departmental record keeping";
export const PAGE_TWO_HEADING = "Revenue by Segment";
export const PAGE_THREE_DECOY = "Enterprise revenue is discussed on page 2 of this report";

export async function buildReportPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const first = pdf.addPage([612, 792]);
  first.drawText("Annual Report", { x: 60, y: 720, size: 20, font: bold });
  first.drawText(PAGE_ONE_SENTINEL, { x: 60, y: 680, size: 12, font });
  first.drawText("Filing procedures and correspondence retained for audit review.", { x: 60, y: 660, size: 12, font });

  const second = pdf.addPage([612, 792]);
  second.drawText(PAGE_TWO_HEADING, { x: 60, y: 720, size: 16, font: bold });
  const columnX = [60, 260, 420];
  let rowY = 680;
  ["Segment", "Revenue 2025", "Revenue 2026"].forEach((cell, column) => {
    second.drawText(cell, { x: columnX[column]!, y: rowY, size: 12, font: bold });
  });
  second.drawLine({ start: { x: 55, y: rowY - 6 }, end: { x: 540, y: rowY - 6 }, thickness: 1, color: rgb(0, 0, 0) });
  for (const row of [["Consumer", "412", "455"], ["Education", "308", "331"], ["Government", "677", "702"], ["Enterprise", "1204", "1318"]]) {
    rowY -= 24;
    row.forEach((cell, column) => second.drawText(cell, { x: columnX[column]!, y: rowY, size: 12, font }));
  }
  second.drawLine({ start: { x: 55, y: rowY - 6 }, end: { x: 540, y: rowY - 6 }, thickness: 1, color: rgb(0, 0, 0) });

  const third = pdf.addPage([612, 792]);
  third.drawText("Notes", { x: 60, y: 720, size: 16, font: bold });
  third.drawText(PAGE_THREE_DECOY, { x: 60, y: 680, size: 12, font });

  return pdf.save();
}

/**
 * A phrase that exists in the scanned fixture only as pixels.
 *
 * Deliberately ordinary words in an unusual arrangement: OCR has to read them, and no text layer
 * or file name can supply them. If a search finds this, something genuinely recognised it.
 */
export const SCANNED_PHRASE = "The escape velocity of Deimos is five point six metres per second";

/**
 * A single-page PDF with no text layer at all: one image, drawn and then embedded.
 *
 * Built at test time rather than committed, following the existing pattern — no binary in git,
 * and the expected text is right here beside the drawing that produces it.
 */
export async function buildScannedPdf(): Promise<Uint8Array> {
  const canvas = createCanvas(1224, 1584);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000000";
  context.font = "36px Helvetica";
  context.fillText(SCANNED_PHRASE, 90, 300);
  context.fillText("Appendix C, recorded during the survey of the outer moons.", 90, 380);

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const image = await pdf.embedPng(canvas.toBuffer("image/png"));
  page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
  return await pdf.save();
}
