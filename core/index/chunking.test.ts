import { describe, expect, it } from "vitest";
import { chunkPages } from "./chunking.js";

const words = (count: number, prefix = "w") =>
  Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(" ");

describe("chunking page text", () => {
  it("never lets a chunk span two pages, so every hit keeps a single page number", () => {
    const chunks = chunkPages("hash", [
      { page: 1, text: words(1000), source: "pdf" },
      { page: 2, text: words(1000, "x"), source: "pdf" },
    ], "balanced");
    for (const chunk of chunks) {
      const onPageOne = chunk.text.includes("w0") || chunk.text.startsWith("w");
      expect(onPageOne ? chunk.page : 2).toBe(chunk.page);
    }
    expect(new Set(chunks.map((c) => c.page))).toEqual(new Set([1, 2]));
    expect(chunks.filter((c) => c.page === 1).every((c) => !c.text.includes("x0"))).toBe(true);
  });

  it("advances by the preset stride so consecutive chunks overlap by the preset amount", () => {
    // balanced is 420 tokens with 70 overlap, so the stride is 350 words.
    const chunks = chunkPages("hash", [{ page: 1, text: words(800), source: "pdf" }], "balanced");
    const first = chunks[0]!.text.split(" ");
    const second = chunks[1]!.text.split(" ");
    expect(first).toHaveLength(420);
    expect(second[0]).toBe("w350");
    expect(first.slice(350)).toEqual(second.slice(0, 70));
  });

  it("builds an identifier that carries hash, profile, version, page and position", () => {
    const chunks = chunkPages("abc123", [{ page: 7, text: words(50), source: "pdf" }], "balanced");
    expect(chunks[0]!.id).toBe("abc123:balanced:1:7:0");
  });

  it("drops fragments too short to retrieve anything useful", () => {
    const chunks = chunkPages("hash", [{ page: 1, text: "tiny", source: "pdf" }], "balanced");
    expect(chunks).toEqual([]);
  });

  it("skips pages with no text at all rather than storing empty rows", () => {
    const chunks = chunkPages("hash", [
      { page: 1, text: "   ", source: "pdf" },
      { page: 2, text: words(50), source: "pdf" },
    ], "balanced");
    expect(chunks.every((c) => c.page === 2)).toBe(true);
  });
});
