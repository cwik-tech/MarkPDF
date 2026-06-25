import { describe, expect, it } from "vitest";
import type { OverlayItem } from "../types";
import { renderAnnotationBlock } from "./fidelity";

describe("renderAnnotationBlock", () => {
  it("labels bookmark overlays in Markdown annotation output", () => {
    const bookmark: OverlayItem = {
      id: "bookmark-1",
      kind: "bookmark",
      page: 1,
      x: 10,
      y: 20,
      width: 1,
      height: 1,
      text: "Important clause",
    };

    expect(renderAnnotationBlock([bookmark])).toContain(
      "- **Bookmark:** Important clause",
    );
  });
});
