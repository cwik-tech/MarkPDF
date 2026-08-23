import { describe, expect, it } from "vitest";
import { isPackagedModulePath } from "./packaging.js";

/**
 * Where this file sits decides whether the offline test embedder can ever be selected. Getting
 * it wrong in the permissive direction would mean a shipped command indexing with meaningless
 * vectors, so the cases are written out rather than inferred.
 */
describe("recognising an installed copy", () => {
  it("treats a module inside the application archive as packaged", () => {
    expect(isPackagedModulePath("/Applications/MarkPDF.app/Contents/Resources/app.asar/dist-cli/main.js")).toBe(true);
  });

  it("treats a module unpacked beside the archive as packaged, because it still ships", () => {
    expect(isPackagedModulePath("/Applications/MarkPDF.app/Contents/Resources/app.asar.unpacked/x.node")).toBe(true);
  });

  it("treats anything else under the application bundle as packaged", () => {
    expect(isPackagedModulePath("/Applications/MarkPDF.app/Contents/Resources/dist-cli/main.js")).toBe(true);
  });

  it("treats a checkout as not packaged", () => {
    expect(isPackagedModulePath("/Users/me/code/MarkPDF/dist-cli/main.js")).toBe(false);
  });

  it("does not mistake a directory that merely mentions the archive name", () => {
    expect(isPackagedModulePath("/Users/me/notes-about-app.asar-format/dist-cli/main.js")).toBe(false);
  });
});
