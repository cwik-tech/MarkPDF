import { describe, expect, it } from "vitest";
import { projectOpenDocuments, type ProjectableTab } from "./openDocuments";

/**
 * What a window tells the rest of the machine about its own tabs.
 *
 * Two properties matter as much as the contents. It carries no document text and no bytes — the
 * only route text takes out of this program is a bounded reply. And it is deliberately *narrow*,
 * so that the things a person does constantly — turning pages, watching a scan progress, running a
 * search — produce the same report as before and therefore no write at all.
 */

function makePdfTab(overrides: Partial<ProjectableTab> = {}): ProjectableTab {
  return {
    kind: "pdf",
    id: "tab-a",
    name: "annual-report.pdf",
    path: "/library/annual-report.pdf",
    pageCount: 3,
    currentPage: 1,
    semanticContentHash: "a".repeat(64),
    dirty: false,
    ...overrides,
  };
}

function makeMarkdownTab(overrides: Partial<ProjectableTab> = {}): ProjectableTab {
  return { kind: "markdown", id: "tab-m", name: "notes.md", path: "/library/notes.md", dirty: false, ...overrides };
}

describe("reporting the documents a window has open", () => {
  it("reports nothing when no document is open", () => {
    expect(projectOpenDocuments([], null)).toEqual({ activeTabId: null, documents: [] });
  });

  it("carries a PDF tab's identity, size and index state", () => {
    const report = projectOpenDocuments([makePdfTab()], "tab-a");

    expect(report).toEqual({
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

  it("keeps the window's own tab order", () => {
    const report = projectOpenDocuments(
      [makePdfTab({ id: "tab-a" }), makePdfTab({ id: "tab-b", name: "second.pdf" })],
      "tab-b",
    );

    expect(report.documents.map((entry) => entry.tabId)).toEqual(["tab-a", "tab-b"]);
    expect(report.activeTabId).toBe("tab-b");
  });

  it("reports a Markdown tab truthfully rather than leaving it out", () => {
    // An agent asking what is open, while a Markdown file is at the front, must be told that —
    // not quietly handed whichever PDF happens to be behind it.
    const report = projectOpenDocuments([makePdfTab(), makeMarkdownTab()], "tab-m");

    expect(report.activeTabId).toBe("tab-m");
    expect(report.documents[1]).toEqual({
      tabId: "tab-m",
      kind: "markdown",
      name: "notes.md",
      path: "/library/notes.md",
      pageCount: 0,
      contentHash: null,
      unsavedChanges: false,
    });
  });

  it("reports a document that has never been saved as having no path", () => {
    const report = projectOpenDocuments([makePdfTab({ path: undefined, dirty: true })], "tab-a");

    expect(report.documents[0]).toMatchObject({ path: null, unsavedChanges: true });
  });

  it("reports a document that has not been indexed as having no content hash", () => {
    const report = projectOpenDocuments([makePdfTab({ semanticContentHash: undefined })], "tab-a");

    expect(report.documents[0]?.contentHash).toBeNull();
  });

  it("says the same thing after the reader turns a page", () => {
    // Page position is the most frequently changing thing about a tab and the least useful thing
    // to know about it from outside. Reporting it would mean writing a file on every scroll.
    const before = projectOpenDocuments([makePdfTab({ currentPage: 1 })], "tab-a");
    const after = projectOpenDocuments([makePdfTab({ currentPage: 97 })], "tab-a");

    expect(after).toEqual(before);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(JSON.stringify(after)).not.toContain("97");
  });

  it("carries no document text and no bytes", () => {
    const report = projectOpenDocuments([makePdfTab(), makeMarkdownTab()], "tab-a");

    for (const entry of report.documents) {
      expect(Object.keys(entry).sort()).toEqual([
        "contentHash",
        "kind",
        "name",
        "pageCount",
        "path",
        "tabId",
        "unsavedChanges",
      ]);
    }
  });

  it("does not claim an active tab that is no longer open", () => {
    // A tab can close between the state change and the report being built.
    expect(projectOpenDocuments([makePdfTab()], "tab-gone").activeTabId).toBeNull();
  });
});
