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

describe("narrowing the recognition phase, which crosses the same channel", () => {
  it("accepts an OCR event with its page counters", () => {
    const event = parseSemanticProgressEvent({
      jobId: "tab-1",
      kind: "index",
      progress: { status: "ocr", current: 1, total: 3, message: "Reading page 4 with OCR" },
    });
    expect(event?.progress.status).toBe("ocr");
    expect(event?.progress.current).toBe(1);
    expect(event?.progress.total).toBe(3);
  });

  it("rejects an OCR event with no counters, because a phase with no extent is not this one", () => {
    // The other statuses may arrive without counts — "Checking index" has no extent to report.
    // Recognition always does: it is emitted per page, from a known list of pages. An OCR event
    // without them is not a phase this application emits, so it is not one to render either.
    expect(
      parseSemanticProgressEvent({ jobId: "t", kind: "index", progress: { status: "ocr" } }),
    ).toBeNull();
    expect(
      parseSemanticProgressEvent({ jobId: "t", kind: "index", progress: { status: "ocr", current: 1 } }),
    ).toBeNull();
    expect(
      parseSemanticProgressEvent({ jobId: "t", kind: "index", progress: { status: "ocr", total: 3 } }),
    ).toBeNull();
  });

  it("rejects OCR counters that are not whole numbers of pages", () => {
    for (const counters of [
      { current: "1", total: 3 },
      { current: 1, total: Number.POSITIVE_INFINITY },
      { current: 1.5, total: 3 },
      { current: 1, total: 3.5 },
      { current: -1, total: 3 },
      { current: Number.NaN, total: 3 },
    ]) {
      expect(
        parseSemanticProgressEvent({ jobId: "t", kind: "index", progress: { status: "ocr", ...counters } }),
        JSON.stringify(counters),
      ).toBeNull();
    }
  });

  it("rejects an OCR event whose position is outside the run it claims to be part of", () => {
    // Pages are counted from one to the total. A zero, or a position past the end, means the event
    // and the run disagree — and a bar drawn from it would read 0% or run off the end.
    expect(
      parseSemanticProgressEvent({ jobId: "t", kind: "index", progress: { status: "ocr", current: 0, total: 3 } }),
    ).toBeNull();
    expect(
      parseSemanticProgressEvent({ jobId: "t", kind: "index", progress: { status: "ocr", current: 4, total: 3 } }),
    ).toBeNull();
    expect(
      parseSemanticProgressEvent({ jobId: "t", kind: "index", progress: { status: "ocr", current: 1, total: 0 } }),
    ).toBeNull();
  });

  it("still discards a status that only looks like the recognition phase", () => {
    expect(
      parseSemanticProgressEvent({ jobId: "t", kind: "index", progress: { status: "ocring" } }),
    ).toBeNull();
  });

  it("leaves the other statuses free to arrive without counts", () => {
    expect(
      parseSemanticProgressEvent({ jobId: "t", kind: "index", progress: { status: "checking" } })?.progress.status,
    ).toBe("checking");
  });
});
