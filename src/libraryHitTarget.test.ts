import { describe, expect, it } from "vitest";
import { acceptsLibraryResponse, libraryHitTarget, missingFileMessage } from "./libraryHitTarget";

/**
 * Where a click on a library hit goes, and which library replies the pane may show.
 *
 * Tabs are addressed by the content hash the index recorded for them, never by name: two open
 * documents can share a name, and the hit must open the one it came from.
 */

const tabs = [
  { id: "tab-1", kind: "pdf" as const, name: "notes.pdf", semanticContentHash: "a".repeat(64) },
  { id: "tab-2", kind: "markdown" as const, name: "notes.pdf" },
  { id: "tab-3", kind: "pdf" as const, name: "notes.pdf", semanticContentHash: "b".repeat(64) },
];

describe("the target of a library hit", () => {
  it("switches to the open tab that holds the same indexed document", () => {
    expect(libraryHitTarget(tabs, { contentHash: "b".repeat(64), path: "/library/notes.pdf" })).toEqual({ kind: "switch", tabId: "tab-3" });
  });

  it("opens the recorded path when no open tab holds the document", () => {
    expect(libraryHitTarget(tabs, { contentHash: "c".repeat(64), path: "/library/other.pdf" })).toEqual({
      kind: "open",
      path: "/library/other.pdf",
    });
  });

  it("explains a hit whose document has no recorded path", () => {
    expect(libraryHitTarget(tabs, { contentHash: "c".repeat(64), path: null })).toEqual({
      kind: "unavailable",
      message: "This document is in the index without a file path.",
    });
  });
});

describe("a hit whose file is gone", () => {
  it("names the path the index recorded, so the person can look for the file", () => {
    expect(missingFileMessage("/library/moved.pdf")).toBe("This document is in the index, but its file is not at /library/moved.pdf.");
  });
});

describe("which library replies the pane may show", () => {
  it("shows the reply to the latest request only", () => {
    expect(acceptsLibraryResponse(3, 3)).toBe(true);
    expect(acceptsLibraryResponse(2, 3)).toBe(false);
  });
});
