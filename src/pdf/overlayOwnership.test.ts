import { describe, expect, it } from "vitest";
import type { OverlayItem } from "../types";
import { ownsOverlay } from "./overlayOwnership";

function makeOverlay(overrides: Partial<OverlayItem> = {}): OverlayItem {
  return {
    id: "overlay-1",
    kind: "comment",
    page: 1,
    x: 72,
    y: 100,
    width: 120,
    height: 12,
    text: "A note",
    ...overrides,
  };
}

describe("whether this reader may change an annotation", () => {
  it("may change one made here", () => {
    expect(ownsOverlay(makeOverlay())).toBe(true);
  });

  it("may not change one the document carries, whatever kind it is", () => {
    for (const kind of ["comment", "highlight", "text"] as const) {
      expect(ownsOverlay(makeOverlay({ kind, source: "document" }))).toBe(false);
    }
  });

  it("may not change an annotation that is not there", () => {
    expect(ownsOverlay(undefined)).toBe(false);
    expect(ownsOverlay(null)).toBe(false);
  });
});
