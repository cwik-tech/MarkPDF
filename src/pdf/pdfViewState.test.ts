import { describe, expect, it } from "vitest";
import { withoutPdfBytes } from "./pdfViewState";

describe("PDF state passed into rendered components", () => {
  it("omits the enumerable byte array while preserving view fields", () => {
    const bytes = new Uint8Array(11_301_466);

    const view = withoutPdfBytes({
      id: "book",
      name: "DAMA DMBOK.pdf",
      pageCount: 628,
      bytes,
    });

    expect(view).toEqual({ id: "book", name: "DAMA DMBOK.pdf", pageCount: 628 });
    expect(Object.keys(view)).not.toContain("bytes");
  });
});
