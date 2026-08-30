import { describe, expect, it } from "vitest";
import { openPdfInStages, yieldToUi } from "./openPdfInStages";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

describe("opening a PDF in visible stages", () => {
  it("waits through two scheduled UI turns before continuing", async () => {
    const turns: Array<() => void> = [];
    let finished = false;

    const waiting = yieldToUi((callback) => turns.push(callback)).then(() => {
      finished = true;
    });
    expect(turns).toHaveLength(1);

    turns.shift()?.();
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(turns).toHaveLength(1);

    turns.shift()?.();
    await waiting;
    expect(finished).toBe(true);
  });

  it("shows the document and lets the browser paint before reading optional metadata", async () => {
    const painted = deferred();
    const preparationStarted = deferred();
    const preparationFinished = deferred();
    const metadataStarted = deferred();
    const metadataFinished = deferred();
    const events: string[] = [];

    const opening = openPdfInStages({
      loadDocument: async () => {
        events.push("document loaded");
        return { pageCount: 628 };
      },
      showDocument: () => events.push("document shown"),
      waitForPaint: async () => {
        events.push("paint requested");
        await painted.promise;
      },
      prepareDocument: async () => {
        events.push("preparation started");
        preparationStarted.resolve();
        await preparationFinished.promise;
      },
      loadMetadata: async () => {
        events.push("metadata started");
        metadataStarted.resolve();
        await metadataFinished.promise;
        return { outlineItems: 187 };
      },
      applyMetadata: () => events.push("metadata applied"),
    });

    await Promise.resolve();
    expect(events).toEqual(["document loaded", "document shown", "paint requested"]);

    painted.resolve();
    await preparationStarted.promise;
    expect(events).toEqual([
      "document loaded",
      "document shown",
      "paint requested",
      "preparation started",
    ]);

    preparationFinished.resolve();
    await metadataStarted.promise;
    expect(events).toEqual([
      "document loaded",
      "document shown",
      "paint requested",
      "preparation started",
      "metadata started",
    ]);

    metadataFinished.resolve();
    await opening;
    expect(events.at(-1)).toBe("metadata applied");
  });
});
