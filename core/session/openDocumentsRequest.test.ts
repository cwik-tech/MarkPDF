import { describe, expect, it } from "vitest";
import { OpenDocumentsRequestError, parseOpenDocumentsPayload } from "./openDocumentsRequest.js";

/**
 * Everything a window says about its own tabs, checked before it reaches a file.
 *
 * The renderer is not trusted. A buggy or compromised one must not be able to write a document
 * name that forges a line of output, a page count that is not a number, or a list long enough to
 * make the file itself the problem. These guards construct the value or throw; they never coerce.
 */

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    activeTabId: "tab-a",
    documents: [
      {
        tabId: "tab-a",
        kind: "pdf",
        name: "annual-report.pdf",
        path: "/library/annual-report.pdf",
        pageCount: 3,
        contentHash: "a".repeat(64),
        unsavedChanges: false,
      },
    ],
    ...overrides,
  };
}

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(payload().documents as Record<string, unknown>[])[0], ...overrides };
}

describe("checking what a window claims it has open", () => {
  it("accepts a well-formed report and keeps every field", () => {
    expect(parseOpenDocumentsPayload(payload())).toEqual({
      activeTabId: "tab-a",
      documents: [
        {
          tabId: "tab-a",
          kind: "pdf",
          name: "annual-report.pdf",
          path: "/library/annual-report.pdf",
          pageCount: 3,
          contentHash: "a".repeat(64),
          unsavedChanges: false,
        },
      ],
    });
  });

  it("accepts a window with nothing open", () => {
    expect(parseOpenDocumentsPayload({ activeTabId: null, documents: [] })).toEqual({
      activeTabId: null,
      documents: [],
    });
  });

  it("accepts a document that has never been saved and has never been indexed", () => {
    const parsed = parseOpenDocumentsPayload(
      payload({ documents: [document({ path: null, contentHash: null, unsavedChanges: true })] }),
    );

    expect(parsed.documents[0]).toMatchObject({ path: null, contentHash: null, unsavedChanges: true });
  });

  it("accepts a Markdown tab, which is reported even though it cannot be read", () => {
    expect(parseOpenDocumentsPayload(payload({ documents: [document({ kind: "markdown", pageCount: 0 })] })).documents[0]?.kind).toBe(
      "markdown",
    );
  });

  it("refuses anything that is not an object", () => {
    for (const wrong of [null, undefined, 7, "documents", []]) {
      expect(() => parseOpenDocumentsPayload(wrong)).toThrow(OpenDocumentsRequestError);
    }
  });

  it("refuses a document list that is not a list", () => {
    expect(() => parseOpenDocumentsPayload(payload({ documents: "annual-report.pdf" }))).toThrow(/documents/);
  });

  it("refuses a name or a path that could forge a line of output", () => {
    expect(() => parseOpenDocumentsPayload(payload({ documents: [document({ name: "report\u001b[2Kfake.pdf" })] }))).toThrow(
      /control character/,
    );
    expect(() => parseOpenDocumentsPayload(payload({ documents: [document({ path: "/library/\u0007bell.pdf" })] }))).toThrow(
      /control character/,
    );
  });

  it("refuses a name or path longer than any real one", () => {
    expect(() => parseOpenDocumentsPayload(payload({ documents: [document({ name: "x".repeat(1025) })] }))).toThrow(/name/);
    expect(() => parseOpenDocumentsPayload(payload({ documents: [document({ path: `/${"x".repeat(4097)}` })] }))).toThrow(/path/);
  });

  it("refuses a page count that is not a whole number of pages", () => {
    for (const wrong of [-1, 1.5, Number.NaN, "3", null]) {
      expect(() => parseOpenDocumentsPayload(payload({ documents: [document({ pageCount: wrong })] }))).toThrow(/pageCount/);
    }
  });

  it("refuses a content hash that is not one", () => {
    for (const wrong of ["", "not-a-hash", "A".repeat(64), "a".repeat(63)]) {
      expect(() => parseOpenDocumentsPayload(payload({ documents: [document({ contentHash: wrong })] }))).toThrow(/contentHash/);
    }
  });

  it("refuses a kind this program does not have", () => {
    expect(() => parseOpenDocumentsPayload(payload({ documents: [document({ kind: "spreadsheet" })] }))).toThrow(/kind/);
  });

  it("refuses an unsaved flag that is not a flag, rather than reading it as false", () => {
    expect(() => parseOpenDocumentsPayload(payload({ documents: [document({ unsavedChanges: "no" })] }))).toThrow(
      /unsavedChanges/,
    );
  });

  it("refuses an active tab that is not one of the documents reported", () => {
    // A window claiming a front tab it did not list would make one document active and unreachable.
    expect(() => parseOpenDocumentsPayload(payload({ activeTabId: "tab-elsewhere" }))).toThrow(/activeTabId/);
  });

  it("refuses two documents sharing one tab identity", () => {
    // References are built from the tab identifier, so a duplicate makes two documents one.
    expect(() =>
      parseOpenDocumentsPayload(payload({ documents: [document(), document({ name: "other.pdf" })] })),
    ).toThrow(/tabId/);
  });

  it("refuses more documents than a person could have open", () => {
    const many = Array.from({ length: 201 }, (_, index) => document({ tabId: `tab-${index}` }));

    expect(() => parseOpenDocumentsPayload({ activeTabId: null, documents: many })).toThrow(/documents/);
  });
});
