import { describe, expect, it } from "vitest";
import { buildIndexSource, semanticIndexOutcome } from "./semanticSource";

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

describe("what a finished index job leaves on the tab", () => {
  /**
   * A document with a page nothing could read is searchable and incomplete at the same time, and
   * the interface has to say both. Marking it merely ready is the silent success this exists to
   * stop: the reader searches it, finds nothing on the page they were looking at, and has no way
   * to know the page was never read.
   */
  it("reports an ordinary document as ready, with nothing to add", () => {
    const outcome = semanticIndexOutcome({ status: "ready", unresolvedPages: [] });

    expect(outcome.status).toBe("ready");
    expect(outcome.message).toBe("Semantic index ready");
  });

  it("still marks an incomplete document searchable, because the rest of it is", () => {
    const outcome = semanticIndexOutcome({ status: "incomplete", unresolvedPages: [10] });

    expect(outcome.status).toBe("ready");
  });

  it("names the page that could not be read", () => {
    expect(semanticIndexOutcome({ status: "incomplete", unresolvedPages: [10] }).message).toBe(
      "Semantic index ready, but page 10 could not be read",
    );
  });

  it("names several pages, and stops listing them before the message becomes one", () => {
    expect(
      semanticIndexOutcome({ status: "incomplete", unresolvedPages: [2, 7, 10] }).message,
    ).toBe("Semantic index ready, but pages 2, 7, 10 could not be read");

    expect(
      semanticIndexOutcome({ status: "incomplete", unresolvedPages: [1, 2, 3, 4, 5, 6, 7] }).message,
    ).toBe("Semantic index ready, but 7 pages could not be read");
  });
});
