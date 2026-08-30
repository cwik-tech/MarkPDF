import { describe, expect, it } from "vitest";
import { ocrPages } from "./ocrPages.js";
import type { PageImage } from "./rasterisePages.js";

describe("streaming OCR page images", () => {
  it("recognises each page before the rasteriser produces the next image", async () => {
    const events: string[] = [];
    async function* images(): AsyncIterable<PageImage> {
      events.push("raster 1");
      yield { page: 1, image: Uint8Array.of(1), width: 1, height: 1 };
      events.push("raster 2");
      yield { page: 2, image: Uint8Array.of(2), width: 1, height: 1 };
    }

    const candidates = await ocrPages(
      { bytes: new Uint8Array(), pages: [1, 2], totalPages: 2 },
      {
        rasteriseStreaming: () => images(),
        createRecogniser: async () => ({
          async recognise(image) {
            const page = image[0];
            if (page === undefined) throw new Error("recogniser received no page marker");
            events.push(`recognise ${page}`);
            return { text: `page ${page}`, lines: [] };
          },
          async close() {},
        }),
      },
    );

    expect(events).toEqual(["raster 1", "recognise 1", "raster 2", "recognise 2"]);
    expect(candidates).toEqual([
      { page: 1, text: "page 1" },
      { page: 2, text: "page 2" },
    ]);
  });

  it("keeps the page already recognised and never requests the next image after cancellation", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    async function* images(): AsyncIterable<PageImage> {
      events.push("raster 1");
      yield { page: 1, image: Uint8Array.of(1), width: 1, height: 1 };
      events.push("raster 2");
      yield { page: 2, image: Uint8Array.of(2), width: 1, height: 1 };
    }

    const candidates = await ocrPages(
      { bytes: new Uint8Array(), pages: [1, 2], totalPages: 2, signal: controller.signal },
      {
        rasteriseStreaming: () => images(),
        createRecogniser: async () => ({
          async recognise() {
            events.push("recognise 1");
            controller.abort();
            return { text: "first page", lines: [] };
          },
          async close() {},
        }),
      },
    );

    expect(events).toEqual(["raster 1", "recognise 1"]);
    expect(candidates).toEqual([{ page: 1, text: "first page" }]);
  });

  it("closes the recognition engine when cancellation arrives during a page", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    let recognitionStartedResolve: (() => void) | undefined;
    const recognitionStarted = new Promise<void>((resolve) => {
      recognitionStartedResolve = resolve;
    });

    async function* images(): AsyncIterable<PageImage> {
      yield { page: 1, image: Uint8Array.of(1), width: 1, height: 1 };
    }

    const pending = ocrPages(
      {
        bytes: new Uint8Array(),
        pages: [1],
        totalPages: 1,
        signal: controller.signal,
      },
      {
        rasteriseStreaming: () => images(),
        createRecogniser: async () => ({
          async recognise() {
            events.push("recognise");
            recognitionStartedResolve?.();
            return await new Promise<never>(() => undefined);
          },
          async close() {
            events.push("close");
          },
        }),
      },
    );

    await recognitionStarted;
    controller.abort();
    await Promise.resolve();

    expect(events).toEqual(["recognise", "close"]);
    await expect(pending).resolves.toEqual([]);
  });
});
