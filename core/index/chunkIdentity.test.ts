import { describe, expect, it } from "vitest";
import { chunkIdentifier, textFingerprint } from "./chunkIdentity.js";

/**
 * What makes two chunks the same chunk.
 *
 * Phase 1 keyed a chunk by the file's bytes plus its position, which is not enough: extraction is
 * not deterministic, so the same file can yield different text at the same position and the reuse
 * check would keep the stale copy. Folding a hash of the text into the identity makes changed
 * text a different chunk, so reuse fails closed rather than open.
 */

const base = {
  contentHash: "a".repeat(64),
  chunkingProfile: "balanced" as const,
  chunkingVersion: 2,
  page: 3,
  index: 1,
  partIndex: 0,
  text: "The escape velocity of Deimos is five point six metres per second.",
};

describe("identifying a chunk", () => {
  it("is stable for the same inputs", () => {
    expect(chunkIdentifier(base)).toBe(chunkIdentifier(base));
  });

  it("changes when the text changes, even at the same position in the same file", () => {
    // The whole point. Same bytes, same page, same position — different text, so a different
    // chunk, so the reuse check rebuilds instead of serving the stale one.
    expect(chunkIdentifier({ ...base, text: `${base.text} Revised.` })).not.toBe(chunkIdentifier(base));
  });

  it("changes when the page changes", () => {
    expect(chunkIdentifier({ ...base, page: 4 })).not.toBe(chunkIdentifier(base));
  });

  it("changes when the position within the page changes", () => {
    expect(chunkIdentifier({ ...base, index: 2 })).not.toBe(chunkIdentifier(base));
  });

  it("changes when the continuation part changes, so a table's windows are distinct", () => {
    expect(chunkIdentifier({ ...base, partIndex: 1 })).not.toBe(chunkIdentifier(base));
  });

  it("changes when the chunking version changes, which is what makes a reindex lazy", () => {
    expect(chunkIdentifier({ ...base, chunkingVersion: 3 })).not.toBe(chunkIdentifier(base));
  });

  it("changes when the profile changes", () => {
    expect(chunkIdentifier({ ...base, chunkingProfile: "precise" })).not.toBe(chunkIdentifier(base));
  });

  it("changes when the document changes", () => {
    expect(chunkIdentifier({ ...base, contentHash: "b".repeat(64) })).not.toBe(chunkIdentifier(base));
  });

  it("stays inside the length a chunk identifier column can hold", () => {
    expect(chunkIdentifier(base).length).toBeLessThanOrEqual(160);
  });

  it("carries the document, page and position in readable form, so a row can be traced", () => {
    // Debuggability is a real requirement here: an opaque hash makes a stored row impossible to
    // relate to a document without querying. The text hash is the only opaque part.
    expect(chunkIdentifier(base).startsWith(`${base.contentHash}:balanced:2:3:1:0:`)).toBe(true);
  });
});

describe("fingerprinting a chunk's text", () => {
  it("ignores differences that do not change what the text says", () => {
    // Whitespace is layout, not content. A re-extraction that re-wraps a paragraph must not
    // invalidate an index that is still correct.
    expect(textFingerprint("Revenue  by\n\nsegment")).toBe(textFingerprint("Revenue by segment"));
  });

  it("does not ignore a changed word", () => {
    expect(textFingerprint("Revenue by segment")).not.toBe(textFingerprint("Revenue by region"));
  });

  it("is case sensitive, because a citation quotes the page", () => {
    expect(textFingerprint("Enterprise")).not.toBe(textFingerprint("enterprise"));
  });

  it("is short enough to sit inside an identifier", () => {
    expect(textFingerprint("anything at all").length).toBe(16);
  });
});
