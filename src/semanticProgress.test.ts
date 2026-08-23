import { describe, expect, it } from "vitest";
import { semanticProgressToUpdate } from "./semanticProgress";

/** The tab still has an index job running, which is the only state that may be updated. */
const liveJob = () => ({ controller: new AbortController() });
/** The renderer cancelled, but the main process has not stopped emitting yet. */
const cancelledJob = () => {
  const controller = new AbortController();
  controller.abort();
  return { controller };
};
/** No job at all: the tab was reset, closed, or never started one. */
const noJob = () => undefined;

describe("turning a main-process progress event into observable state", () => {
  it("moves a tab into the status the event reports, with its counts", () => {
    // This is what makes the toolbar badge read "Indexing 3 of 12" while main works.
    const update = semanticProgressToUpdate({
      jobId: "tab-1",
      kind: "index",
      progress: { status: "indexing", current: 3, total: 12, message: "Indexing 3 of 12" },
    }, liveJob);

    expect(update).toEqual({
      kind: "index",
      tabId: "tab-1",
      patch: {
        semanticIndexStatus: "indexing",
        semanticIndexProgress: { status: "indexing", current: 3, total: 12, message: "Indexing 3 of 12" },
        semanticIndexError: undefined,
      },
    });
  });

  it("ignores a ready event, because readiness must come with the content hash", () => {
    // indexDocument emits ready just before returning, so this event can overtake the invoke
    // result. Acting on it would mark the tab searchable with no hash recorded, and the next
    // search would silently return nothing.
    expect(
      semanticProgressToUpdate({
        jobId: "tab-1",
        kind: "index",
        progress: { status: "ready", current: 12, total: 12, message: "Semantic index ready" },
      }, liveJob),
    ).toBeNull();
  });

  it("clears a previous error when progress resumes", () => {
    const update = semanticProgressToUpdate({
      jobId: "tab-1",
      kind: "index",
      progress: { status: "checking", message: "Checking semantic index" },
    }, liveJob);
    expect(update?.kind).toBe("index");
    if (update?.kind === "index") expect(update.patch.semanticIndexError).toBeUndefined();
  });

  it("reports a model download as a percentage, which is what the settings dialog showed", () => {
    // Before the cutover this came from downloadSemanticModel's callback. It has to keep
    // working, routed by the job identifier its requester chose.
    const update = semanticProgressToUpdate({
      jobId: "settings-download-Xenova/bge-small-en-v1.5",
      kind: "model",
      progress: { status: "downloading", current: 25, total: 200 },
    });

    expect(update).toEqual({
      kind: "model",
      jobId: "settings-download-Xenova/bge-small-en-v1.5",
      progress: { status: "downloading", current: 25, total: 200 },
      percent: 13,
    });
  });

  it("reports no percentage when the download size is not yet known", () => {
    const update = semanticProgressToUpdate({
      jobId: "auto-model-download",
      kind: "model",
      progress: { status: "downloading" },
    });
    expect(update?.kind).toBe("model");
    if (update?.kind === "model") expect(update.percent).toBeNull();
  });

  it("ignores an index event for a tab with no job left, so a late event cannot revive it", () => {
    // Turning semantic search off resets every tab and cancels its job, but the main process
    // cannot abandon an embedding call already in flight and keeps emitting for a moment.
    // Applying one of those would put "Indexing" back on a tab the user just switched off.
    expect(
      semanticProgressToUpdate({
        jobId: "tab-1",
        kind: "index",
        progress: { status: "indexing", current: 4, total: 12, message: "Indexing 4 of 12" },
      }, noJob),
    ).toBeNull();
  });

  it("ignores an index event whose job the renderer has already cancelled", () => {
    // A job is marked cancelled before it is removed, and it is removed only by whoever owns
    // it. Both states must stop updates, or the window between them leaks progress.
    expect(
      semanticProgressToUpdate({
        jobId: "tab-1",
        kind: "index",
        progress: { status: "indexing", current: 4, total: 12, message: "Indexing 4 of 12" },
      }, cancelledJob),
    ).toBeNull();
  });

  it("ignores index events when the caller tracks no jobs at all, such as the settings dialog", () => {
    // The settings dialog subscribes for model download percentages. It has no tabs, so an
    // index event addressed to a tab id means nothing there and must not be routed.
    expect(
      semanticProgressToUpdate({
        jobId: "tab-1",
        kind: "index",
        progress: { status: "indexing", current: 4, total: 12, message: "Indexing 4 of 12" },
      }),
    ).toBeNull();
  });

  it("still reports model downloads when the caller tracks no jobs", () => {
    const update = semanticProgressToUpdate({
      jobId: "auto-model-download",
      kind: "model",
      progress: { status: "downloading", current: 50, total: 100 },
    });
    expect(update?.kind).toBe("model");
    if (update?.kind === "model") expect(update.percent).toBe(50);
  });

  it("does not divide by a zero total", () => {
    const update = semanticProgressToUpdate({
      jobId: "auto-model-download",
      kind: "model",
      progress: { status: "downloading", current: 0, total: 0 },
    });
    if (update?.kind === "model") expect(update.percent).toBeNull();
  });
});
