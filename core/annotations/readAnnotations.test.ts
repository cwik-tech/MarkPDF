import { describe, expect, it } from "vitest";
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from "pdf-lib";
import { readDocumentAnnotations } from "./readAnnotations.js";
import {
  buildReviewedContract,
  MARKPDF_COMMENT_ID,
  MARKPDF_NOTE,
  REVIEWER,
  REVIEWER_NOTE,
} from "./reviewedContract.test-support.js";

/** A page with whatever annotation dictionaries a test hands in, and an optional MarkPDF keyword. */
async function pageWith(annotations: Array<Record<string, unknown>>, keyword?: unknown): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText("Some text", { x: 72, y: 700, size: 14, font });
  const refs = annotations.map((entry) => pdf.context.register(pdf.context.obj(entry as never)));
  if (refs.length > 0) page.node.set(PDFName.of("Annots"), pdf.context.obj(refs));
  if (keyword !== undefined) {
    pdf.setKeywords([`markpdf-overlays:${Buffer.from(JSON.stringify(keyword), "utf8").toString("base64")}`]);
  }
  return await pdf.save();
}

describe("readDocumentAnnotations", () => {
  it("reads other applications' annotations and MarkPDF's own once each, in reading order", async () => {
    const annotations = await readDocumentAnnotations(await buildReviewedContract());

    expect(annotations.map((entry) => [entry.origin, entry.type, entry.author, entry.note])).toEqual([
      ["other_application", "highlight", REVIEWER, REVIEWER_NOTE],
      ["other_application", "highlight", REVIEWER, null],
      ["person_in_markpdf", "comment", null, MARKPDF_NOTE],
    ]);
    expect(annotations[2]?.id).toBe(MARKPDF_COMMENT_ID);
    expect(annotations[0]?.id).toBe("document-annotation-1-reviewer-1");
    expect(annotations[0]?.modified).toBe("2026-10-30T10:12:00.000Z");
  });

  it("keeps a highlight that has no note, which the window does not list", async () => {
    const bytes = await pageWith([
      { Type: "Annot", Subtype: "Highlight", Rect: [70, 690, 200, 715], QuadPoints: [72, 714, 198, 714, 72, 697, 198, 697], NM: PDFString.of("plain") },
    ]);
    const [only] = await readDocumentAnnotations(bytes);
    expect(only).toMatchObject({ type: "highlight", note: null, author: null, origin: "other_application" });
  });

  it("reports an agent annotation MarkPDF saved as the agent's", async () => {
    const bytes = await pageWith([], [
      {
        id: "comment-agent",
        kind: "comment",
        page: 1,
        x: 72,
        y: 80,
        width: 100,
        height: 14,
        text: "This conflicts with clause 9.",
        origin: { kind: "agent", agent: "claude-code", suggestedAt: "2026-10-31T10:00:00.000Z", acceptedAt: "2026-10-31T10:01:00.000Z" },
      },
    ]);
    const [only] = await readDocumentAnnotations(bytes);
    expect(only).toMatchObject({ origin: "agent_via_markpdf", author: "claude-code", note: "This conflicts with clause 9." });
  });

  it("links a reply to the annotation it answers", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]);
    const first = pdf.context.register(
      pdf.context.obj({ Type: "Annot", Subtype: "Text", Rect: [72, 700, 96, 724], Contents: PDFHexString.fromText("Question"), NM: PDFString.of("q") }),
    );
    const reply = pdf.context.register(
      pdf.context.obj({ Type: "Annot", Subtype: "Text", Rect: [72, 650, 96, 674], Contents: PDFHexString.fromText("Answer"), NM: PDFString.of("a"), IRT: first }),
    );
    page.node.set(PDFName.of("Annots"), pdf.context.obj([first, reply]));
    const annotations = await readDocumentAnnotations(await pdf.save());
    expect(annotations.map((entry) => [entry.note, entry.replyTo])).toEqual([
      ["Question", null],
      ["Answer", "document-annotation-1-q"],
    ]);
  });

  it("drops page furniture and annotations whose place cannot be trusted", async () => {
    const bytes = await pageWith([
      { Type: "Annot", Subtype: "Link", Rect: [72, 700, 200, 720], NM: PDFString.of("link") },
      { Type: "Annot", Subtype: "Popup", Rect: [72, 700, 200, 720], NM: PDFString.of("popup") },
      { Type: "Annot", Subtype: "Highlight", QuadPoints: [72, 714, 198, 714, 72], Contents: PDFString.of("broken"), NM: PDFString.of("bad") },
    ]);
    expect(await readDocumentAnnotations(bytes)).toEqual([]);
  });

  it("answers only for the pages asked for", async () => {
    const pdf = await PDFDocument.create();
    for (let index = 0; index < 3; index += 1) {
      const page = pdf.addPage([612, 792]);
      page.node.set(
        PDFName.of("Annots"),
        pdf.context.obj([
          pdf.context.register(
            pdf.context.obj({ Type: "Annot", Subtype: "Text", Rect: [72, 700, 96, 724], Contents: PDFString.of(`Note ${String(index + 1)}`) }),
          ),
        ]),
      );
    }
    const annotations = await readDocumentAnnotations(await pdf.save(), { pages: [1, 3] });
    expect(annotations.map((entry) => entry.note)).toEqual(["Note 1", "Note 3"]);
  });
});
