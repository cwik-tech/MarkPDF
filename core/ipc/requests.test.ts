import { describe, expect, it } from "vitest";
import { parseIndexRequest, parseSearchRequest, parseDownloadRequest, parseContentHash } from "./requests.js";

const HASH = "a".repeat(64);
const validIndex = {
  jobId: "tab-1",
  source: { kind: "path", path: "/tmp/a.pdf" },
  name: "a.pdf",
  chunkingProfile: "balanced",
};

describe("validating an index request", () => {
  it("accepts a well-formed request", () => {
    expect(parseIndexRequest(validIndex).name).toBe("a.pdf");
  });

});

describe("validating the scalar fields of an index request", () => {
  it("rejects a force value that is not a boolean rather than reading it as false", () => {
    expect(() => parseIndexRequest({ ...validIndex, force: "true" })).toThrow(/force/);
    expect(() => parseIndexRequest({ ...validIndex, force: 1 })).toThrow(/force/);
  });

  it("treats an absent force as no rebuild, and an explicit true as one", () => {
    expect(parseIndexRequest(validIndex).force).toBe(false);
    expect(parseIndexRequest({ ...validIndex, force: true }).force).toBe(true);
  });
});

describe("what a window may put into the index", () => {
  /**
   * A window contributes a document to index; it does not contribute what the pages say.
   *
   * It used to. The window recognised scanned pages for its own display and offered that text
   * here, and reading accepted it in place of doing the work itself — which meant a page the
   * window had *not* recognised was a page nothing recognised, and a page it had recognised went
   * into the index in whatever shape the window's engine happened to produce. Both are how one
   * document came to read differently depending on which surface indexed it.
   *
   * So the field is gone rather than merely unused. A parameter kept only so a second producer of
   * page text could reappear is the drift this closes.
   */
  const parsed = (request: unknown): Record<string, unknown> => ({ ...parseIndexRequest(request) });

  it("carries no page text, so a window cannot decide what a page says", () => {
    expect(parsed(validIndex)).not.toHaveProperty("ocrCandidates");
  });

  it("ignores page text a window offers anyway, rather than indexing it", () => {
    const offered = { ...validIndex, ocrCandidates: [{ page: 2, text: "scanned words" }] };

    expect(parsed(offered)).not.toHaveProperty("ocrCandidates");
    expect(JSON.stringify(parsed(offered))).not.toContain("scanned words");
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
