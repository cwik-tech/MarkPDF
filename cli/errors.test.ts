import { describe, expect, it } from "vitest";
import { classifyDocumentFailure, classifyRunFailure } from "./errors.js";
import { EXIT_CODE } from "./exit.js";
import { AccessDeniedError } from "../dist-core/consent/allowlist.js";
import { extractPagesFromPdf, PdfInspectorError } from "../dist-core/extract/pdfInspector.js";
import { RasterisationCancelled } from "../dist-core/ocr/rasterisePages.js";

/**
 * Which number the caller gets, and why.
 *
 * The distinction that matters most here is between "this document is not a PDF" and "something
 * in this program went wrong". A catch-all that answered `parseFailed` would tell somebody their
 * file was corrupt when the real fault was a model that failed to load, and they would go and
 * look at the file.
 */

describe("a document that cannot be read", () => {
  it("is a parse failure, judged by what the installed extractor actually throws", async () => {
    // Not a synthetic stand-in: the real binding, given real rubbish, so the classification is
    // tied to the failure the product will genuinely see.
    let thrown: unknown;
    try {
      await extractPagesFromPdf(new TextEncoder().encode("this is plain text, not a PDF"));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PdfInspectorError);
    expect(classifyDocumentFailure(thrown, "notes.pdf").code).toBe(EXIT_CODE.parseFailed);
  });
});

describe("a fault that has nothing to do with the document", () => {
  it("is not reported as a bad PDF", () => {
    const bug = new TypeError("embedder.embed is not a function");

    expect(classifyDocumentFailure(bug, "report.pdf").code).toBe(EXIT_CODE.unexpected);
  });

  it("is not reported as a bad PDF merely because it happened while reading one", () => {
    const network = Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });

    expect(classifyDocumentFailure(network, "report.pdf").code).toBe(EXIT_CODE.unexpected);
  });
});

describe("conditions that have their own number", () => {
  it("reports a refusal as access denied, with the remedy attached", () => {
    const failure = classifyDocumentFailure(new AccessDeniedError("/Users/me/x.pdf", "read"), "/Users/me/x.pdf");

    expect(failure.code).toBe(EXIT_CODE.accessDenied);
    expect(failure.remedy).toContain("--allow-read");
  });

  it("reports a path that is not there as not found", () => {
    const missing = Object.assign(new Error("ENOENT"), { code: "ENOENT" });

    expect(classifyDocumentFailure(missing, "gone.pdf").code).toBe(EXIT_CODE.notFound);
  });

  it("reports a locked index as busy rather than as a failure of the document", () => {
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

    expect(classifyDocumentFailure(busy, "report.pdf").code).toBe(EXIT_CODE.indexBusy);
  });

  it("reports a cancelled page render as an interruption, not as a fault", () => {
    // Rendering is the one step long enough to be stopped part-way. Landing on the
    // unexpected-failure code would tell an agent the tool is broken.
    expect(classifyDocumentFailure(new RasterisationCancelled(), "scan.pdf").code).toBe(EXIT_CODE.interrupted);
    expect(classifyRunFailure(new RasterisationCancelled()).code).toBe(EXIT_CODE.interrupted);
  });

  it("reports a native module that will not load as a missing dependency", () => {
    const dlopen = Object.assign(new Error("dlopen failed"), { code: "ERR_DLOPEN_FAILED" });

    expect(classifyDocumentFailure(dlopen, "report.pdf").code).toBe(EXIT_CODE.missingDependency);
  });

  it("still sees a missing dependency the extractor happened to wrap", () => {
    // The extractor turns anything its native call raises into its own error type. If that
    // wrapping hid a module that would not load, every document would be reported as corrupt and
    // nobody would look at the installation.
    const wrapped = new PdfInspectorError("extraction failed", {
      cause: Object.assign(new Error("Cannot find module 'pdf-inspector.darwin-arm64.node'"), { code: "MODULE_NOT_FOUND" }),
    });

    expect(classifyDocumentFailure(wrapped, "report.pdf").code).toBe(EXIT_CODE.missingDependency);
  });
});

describe("a failure that ended the whole run", () => {
  it("is unexpected unless it is one of the named conditions", () => {
    expect(classifyRunFailure(new Error("something odd")).code).toBe(EXIT_CODE.unexpected);
  });

  it("is still access denied when that is what it was", () => {
    expect(classifyRunFailure(new AccessDeniedError("/x", "write")).code).toBe(EXIT_CODE.accessDenied);
  });
});
