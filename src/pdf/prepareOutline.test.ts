import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, PDFNumber } from "pdf-lib";
import { prepareOutline } from "./prepareOutline";

const outline = [{ id: "summary", title: "Summary", page: 1, children: [] }];
async function source() {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.setKeywords(["machine learning, AI"]);
  return pdf;
}
describe("preparing automatic outline metadata", () => {
  it("preserves unrelated keywords while persisting the outline", async () => {
    const pdf = await source();
    const result = await prepareOutline(await pdf.save(), outline);
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") throw new Error("Expected eligible PDF");
    const saved = await PDFDocument.load(result.bytes);
    expect(saved.getKeywords()).toContain("machine learning, AI");
    expect(saved.getKeywords()).toContain("markpdf-outline:");
  });
  it("refuses forms without returning replacement bytes", async () => {
    const pdf = await source();
    pdf.getForm().createTextField("customer");
    expect(await prepareOutline(await pdf.save(), outline)).toEqual({ status: "blocked", reason: "forms" });
  });
  it("refuses signature dictionaries without returning replacement bytes", async () => {
    const pdf = await source();
    pdf.catalog.set(PDFName.of("ByteRange"), pdf.context.obj([PDFNumber.of(0), PDFNumber.of(12)]));
    expect(await prepareOutline(await pdf.save(), outline)).toEqual({ status: "blocked", reason: "signature" });
  });
});
it("refuses XFA-only forms without deleting their data", async () => {
  const pdf = await source();
  pdf.catalog.set(PDFName.of("AcroForm"), pdf.context.obj({ XFA: pdf.context.obj("original form data") }));
  expect(await prepareOutline(await pdf.save(), outline)).toEqual({ status: "blocked", reason: "forms" });
});
