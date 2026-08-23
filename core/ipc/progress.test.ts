import { describe, expect, it } from "vitest";
import { parseSemanticProgressEvent } from "./progress.js";

describe("narrowing a progress event from the main process", () => {
  it("accepts a well-formed indexing event", () => {
    const event = parseSemanticProgressEvent({
      jobId: "tab-1",
      kind: "index",
      progress: { status: "indexing", current: 3, total: 12, message: "Indexing 3 of 12" },
    });
    expect(event?.progress.current).toBe(3);
    expect(event?.progress.total).toBe(12);
  });

  it("discards an event that is not an object, rather than rendering undefined in the toolbar", () => {
    for (const bad of [null, undefined, "progress", 7, []]) {
      expect(parseSemanticProgressEvent(bad)).toBeNull();
    }
  });

  it("discards an unknown status, which would otherwise reach the status badge", () => {
    expect(parseSemanticProgressEvent({ jobId: "t", kind: "index", progress: { status: "exploding" } })).toBeNull();
  });

  it("discards an unknown kind and a missing job identifier", () => {
    expect(parseSemanticProgressEvent({ jobId: "t", kind: "other", progress: { status: "ready" } })).toBeNull();
    expect(parseSemanticProgressEvent({ jobId: "", kind: "index", progress: { status: "ready" } })).toBeNull();
  });

  it("drops counts that are not usable numbers instead of passing NaN to the progress bar", () => {
    const event = parseSemanticProgressEvent({
      jobId: "t",
      kind: "index",
      progress: { status: "indexing", current: Number.NaN, total: -1, message: 7 },
    });
    expect(event?.progress.current).toBeUndefined();
    expect(event?.progress.total).toBeUndefined();
    expect(event?.progress.message).toBeUndefined();
  });
});
