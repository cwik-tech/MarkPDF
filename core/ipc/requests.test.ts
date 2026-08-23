import { describe, expect, it } from "vitest";
import { parseIndexRequest, parseSearchRequest, parseDownloadRequest, parseContentHash } from "./requests.js";

const HASH = "a".repeat(64);
const validIndex = {
  jobId: "tab-1",
  source: { kind: "path", path: "/tmp/a.pdf" },
  name: "a.pdf",
  pages: [
    { page: 1, text: "one", source: "pdf" },
    { page: 2, text: "two", source: "pdf" },
  ],
  pageCount: 2,
  chunkingProfile: "balanced",
};

describe("validating an index request", () => {
  it("accepts a well-formed request", () => {
    expect(parseIndexRequest(validIndex).pages).toHaveLength(2);
  });

  it("rejects a page number beyond the document, which would cite a page that does not exist", () => {
    expect(() =>
      parseIndexRequest({ ...validIndex, pages: [{ page: 7, text: "x", source: "pdf" }] }),
    ).toThrow(/outside 1..2/);
  });

  it("rejects a page number below one", () => {
    expect(() =>
      parseIndexRequest({ ...validIndex, pages: [{ page: 0, text: "x", source: "pdf" }] }),
    ).toThrow(/outside 1..2/);
  });

  it("rejects duplicate pages, which would double-count a page's text", () => {
    expect(() =>
      parseIndexRequest({
        ...validIndex,
        pages: [
          { page: 1, text: "x", source: "pdf" },
          { page: 1, text: "y", source: "pdf" },
        ],
      }),
    ).toThrow(/ascending order/);
  });

  it("rejects out-of-order pages, so stored chunk positions follow the document", () => {
    expect(() =>
      parseIndexRequest({
        ...validIndex,
        pages: [
          { page: 2, text: "x", source: "pdf" },
          { page: 1, text: "y", source: "pdf" },
        ],
      }),
    ).toThrow(/ascending order/);
  });
});

describe("validating the scalar fields of an index request", () => {
  it("rejects a page count of zero, because a document with no pages cannot be indexed", () => {
    // Zero passed the old non-negative check and then produced an unindexable request whose
    // every page was already out of range — a confusing failure much later than this one.
    expect(() => parseIndexRequest({ ...validIndex, pageCount: 0, pages: [] })).toThrow(
      /pageCount/,
    );
  });

  it("still rejects a negative or fractional page count", () => {
    expect(() => parseIndexRequest({ ...validIndex, pageCount: -1 })).toThrow(/pageCount/);
    expect(() => parseIndexRequest({ ...validIndex, pageCount: 2.5 })).toThrow(/pageCount/);
  });

  it("accepts a single-page document", () => {
    expect(
      parseIndexRequest({
        ...validIndex,
        pageCount: 1,
        pages: [{ page: 1, text: "one", source: "pdf" }],
      }).pageCount,
    ).toBe(1);
  });

  it("rejects a force value that is not a boolean rather than reading it as false", () => {
    // Coercing "true" to false is the dangerous direction: the user asked for a rebuild and
    // silently got the cached index back.
    expect(() => parseIndexRequest({ ...validIndex, force: "true" })).toThrow(/force/);
    expect(() => parseIndexRequest({ ...validIndex, force: 1 })).toThrow(/force/);
  });

  it("treats an absent force as no rebuild, and an explicit true as one", () => {
    expect(parseIndexRequest(validIndex).force).toBe(false);
    expect(parseIndexRequest({ ...validIndex, force: true }).force).toBe(true);
    expect(parseIndexRequest({ ...validIndex, force: false }).force).toBe(false);
  });
});

describe("validating the path carried alongside inline bytes", () => {
  const withBytes = { ...validIndex, source: { kind: "bytes", bytes: [1, 2, 3] } };

  it("rejects a path that is present but not a string, rather than dropping it", () => {
    // The path becomes documents.file_path, which the CLI resolves against before touching the
    // filesystem. Silently storing null there turns a locatable document into an unlocatable
    // one, with nothing reported.
    expect(() =>
      parseIndexRequest({ ...withBytes, source: { ...withBytes.source, path: 42 } }),
    ).toThrow(/source.path/);
  });

  it("rejects an empty path, which is not a location", () => {
    expect(() =>
      parseIndexRequest({ ...withBytes, source: { ...withBytes.source, path: "" } }),
    ).toThrow(/source.path/);
  });

  it("keeps an absent path as null, which is a document with no file on disk", () => {
    expect(parseIndexRequest(withBytes).filePath).toBeNull();
  });

  it("keeps a well-formed path", () => {
    expect(
      parseIndexRequest({ ...withBytes, source: { ...withBytes.source, path: "/tmp/a.pdf" } })
        .filePath,
    ).toBe("/tmp/a.pdf");
  });
});

describe("validating inline document bytes", () => {
  const withBytes = (bytes: unknown) => ({
    ...validIndex,
    source: { kind: "bytes", bytes },
  });

  it("accepts a Uint8Array", () => {
    expect(parseIndexRequest(withBytes(Uint8Array.from([1, 2, 3]))).bytes).toBeInstanceOf(Uint8Array);
  });

  it("accepts a plain array of byte values, which is how the bridge may deliver them", () => {
    expect(parseIndexRequest(withBytes([0, 255])).bytes).toBeInstanceOf(Uint8Array);
  });

  it("rejects values that are not whole numbers in the byte range", () => {
    // Each of these silently coerced before: NaN became 0, 3.7 truncated, 300 wrapped to 44.
    for (const bad of [[Number.NaN], [3.7], [300], [-1], ["7"], [null]]) {
      expect(() => parseIndexRequest(withBytes(bad))).toThrow(/whole numbers between 0 and 255/);
    }
  });
});

describe("validating a model download request", () => {
  it("accepts a curated model", () => {
    expect(parseDownloadRequest({ jobId: "j", modelId: "Xenova/bge-small-en-v1.5" }).modelId).toBe(
      "Xenova/bge-small-en-v1.5",
    );
  });

  it("allows the model to be omitted, meaning the configured one", () => {
    expect(parseDownloadRequest({ jobId: "j" }).modelId).toBeUndefined();
  });

  it("rejects a model that is not curated, rather than recording it as downloaded", () => {
    // The catalogue lookup silently falls back to the default, so an unknown id would be
    // written into downloadedModelIds having never been fetched.
    expect(() => parseDownloadRequest({ jobId: "j", modelId: "evil/not-a-model" })).toThrow(
      /not a curated embedding model/,
    );
  });
});

describe("validating a content hash", () => {
  it("accepts a lower-case sha-256", () => {
    expect(parseContentHash(HASH)).toBe(HASH);
  });

  it("rejects anything else, so it cannot become a path segment", () => {
    for (const bad of [HASH.toUpperCase(), "../etc/passwd", "abc", 7, null]) {
      expect(() => parseContentHash(bad)).toThrow();
    }
  });
});

describe("validating a search request", () => {
  it("rejects a top-k outside the supported range", () => {
    const base = { contentHash: HASH, query: "x", chunkingProfile: "balanced" };
    expect(() => parseSearchRequest({ ...base, topK: 0 })).toThrow(/between 1 and 200/);
    expect(() => parseSearchRequest({ ...base, topK: 2.5 })).toThrow(/between 1 and 200/);
  });
});
