import { describe, expect, it } from "vitest";
import { buildScannedStressPdf } from "../../cli/journeys/adversarialFixture.test-support.js";
import { ocrPages } from "./ocrPages.js";

const PAGE_COUNT = 60;
const MAX_RSS_GROWTH_BYTES = 256 * 1024 * 1024;

describe("streaming OCR memory", () => {
  it("keeps RSS growth below 256 MiB while rasterising sixty scanned pages", async () => {
    const bytes = await buildScannedStressPdf(PAGE_COUNT);
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sample = (): void => {
      peak = Math.max(peak, process.memoryUsage().rss);
    };

    const candidates = await ocrPages(
      {
        bytes,
        pages: Array.from({ length: PAGE_COUNT }, (_unused, index) => index + 1),
        onProgress: sample,
      },
      {
        createRecogniser: async () => ({
          async recognise() {
            sample();
            return { text: "recognised page", lines: [] };
          },
          async close() {
            sample();
          },
        }),
      },
    );
    sample();

    expect(candidates).toHaveLength(PAGE_COUNT);
    expect(peak - baseline).toBeLessThan(MAX_RSS_GROWTH_BYTES);
  }, 300_000);
});
