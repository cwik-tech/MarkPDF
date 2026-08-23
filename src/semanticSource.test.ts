import { describe, expect, it } from "vitest";
import { buildIndexSource } from "./semanticSource";

const bytes = new TextEncoder().encode("the document as loaded in this window");

describe("choosing what the main process hashes", () => {
  it("sends the loaded bytes, so the hash and the page text describe the same document", () => {
    // The page text in the same request was extracted from these bytes. Asking main to read the
    // file again would hash whatever is on disk now, and a file changed since opening would be
    // stored under a hash its chunks never came from.
    const source = buildIndexSource({ path: "/tmp/paper.pdf", bytes });
    expect(source.kind).toBe("bytes");
    if (source.kind === "bytes") expect(source.bytes).toBe(bytes);
  });

  it("still carries the path, which is recorded as the document's location", () => {
    const source = buildIndexSource({ path: "/tmp/paper.pdf", bytes });
    if (source.kind === "bytes") expect(source.path).toBe("/tmp/paper.pdf");
  });

  it("works for a document that has never been saved", () => {
    const source = buildIndexSource({ bytes });
    expect(source.kind).toBe("bytes");
    if (source.kind === "bytes") expect(source.path).toBeUndefined();
  });

  it("never asks the main process to read from a path", () => {
    // A path source would reintroduce the mismatch above.
    for (const tab of [{ bytes }, { path: "/tmp/a.pdf", bytes }]) {
      expect(buildIndexSource(tab).kind).not.toBe("path");
    }
  });
});
