import { describe, expect, it } from "vitest";
import { withRequestBound, DOWNLOAD_TIMEOUT_MS } from "./boundedFetch.js";

function recordingFetch() {
  const seen: Array<{ input: unknown; init: Record<string, unknown> }> = [];
  const fetchLike = async (input: string | URL, init?: unknown) => {
    seen.push({ input, init: (init ?? {}) as Record<string, unknown> });
    return { ok: true };
  };
  return { seen, fetchLike };
}

describe("bounding model download requests", () => {
  it("installs an abort signal on a request that has none", async () => {
    const { seen, fetchLike } = recordingFetch();
    await withRequestBound(fetchLike)("https://example.test/model.onnx");
    expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("preserves the headers and method the library set", async () => {
    const { seen, fetchLike } = recordingFetch();
    await withRequestBound(fetchLike)("https://example.test/x", {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      cache: "no-store",
    });
    expect(seen[0]?.init.method).toBe("GET");
    expect(seen[0]?.init.headers).toEqual({ Range: "bytes=0-0" });
    expect(seen[0]?.init.cache).toBe("no-store");
  });

  it("keeps a caller's own signal effective rather than discarding it", async () => {
    // Overwriting an existing signal would silently disable a cancellation the library or a
    // future caller relies on.
    const { seen, fetchLike } = recordingFetch();
    const controller = new AbortController();
    await withRequestBound(fetchLike)("https://example.test/x", { signal: controller.signal });

    const combined = seen[0]?.init.signal;
    expect(combined).toBeInstanceOf(AbortSignal);
    expect((combined as AbortSignal).aborted).toBe(false);
    controller.abort(new Error("caller cancelled"));
    expect((combined as AbortSignal).aborted).toBe(true);
  });

  it("tolerates a non-object init rather than asserting its shape", async () => {
    const { seen, fetchLike } = recordingFetch();
    await withRequestBound(fetchLike)("https://example.test/x", "not an object");
    expect(seen[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("publishes the bound it applies, so the policy is inspectable rather than implicit", () => {
    expect(Number.isInteger(DOWNLOAD_TIMEOUT_MS)).toBe(true);
    expect(DOWNLOAD_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
