import { describe, expect, it } from "vitest";
import {
  diagramFileName,
  diagramZoomLabel,
  stepDiagramZoom,
  svgNaturalWidth,
} from "./mermaidView";

describe("zooming a diagram", () => {
  it("moves through the steps a reader can see in the label", () => {
    const seen: string[] = [];
    let zoom = 1;
    for (let click = 0; click < 6; click += 1) {
      zoom = stepDiagramZoom(zoom, 1);
      seen.push(diagramZoomLabel(zoom));
    }
    expect(seen).toEqual(["125%", "150%", "200%", "300%", "400%", "400%"]);
  });

  it("shrinks below the fitted size and stops at a quarter of it", () => {
    const seen: string[] = [];
    let zoom = 1;
    for (let click = 0; click < 4; click += 1) {
      zoom = stepDiagramZoom(zoom, -1);
      seen.push(diagramZoomLabel(zoom));
    }
    expect(seen).toEqual(["75%", "50%", "25%", "25%"]);
  });

  it("moves to the next step from a level between two steps", () => {
    expect(stepDiagramZoom(1.1, 1)).toBe(1.25);
    expect(stepDiagramZoom(1.1, -1)).toBe(1);
  });
});

describe("the natural width of a rendered diagram", () => {
  it("is the maximum width Mermaid gives a chart that scales to its container", () => {
    expect(
      svgNaturalWidth({ maxWidth: "1234.5px", viewBox: "0 0 999 400", width: "100%" }),
    ).toBe(1234.5);
  });

  it("falls back to the view box when the chart has no maximum width", () => {
    expect(svgNaturalWidth({ maxWidth: "", viewBox: "-8 -8 640.25 300", width: null })).toBe(
      640.25,
    );
  });

  it("falls back to a fixed width in pixels", () => {
    expect(svgNaturalWidth({ maxWidth: "", viewBox: null, width: "800" })).toBe(800);
    expect(svgNaturalWidth({ maxWidth: "", viewBox: null, width: "800px" })).toBe(800);
  });

  it("is unknown when nothing states a size in pixels", () => {
    expect(svgNaturalWidth({ maxWidth: "50%", viewBox: "0 0 0 0", width: "100%" })).toBeNull();
    expect(svgNaturalWidth({ maxWidth: "", viewBox: "garbage", width: null })).toBeNull();
  });
});

describe("the name offered for a downloaded diagram", () => {
  it("names the document and the diagram's place in it", () => {
    expect(diagramFileName("cf-launcher-plan.md", 2)).toBe("cf-launcher-plan-diagram-2.svg");
  });

  it("uses a plain name when the document has none", () => {
    expect(diagramFileName(undefined, 1)).toBe("diagram-1.svg");
    expect(diagramFileName("  ", 1)).toBe("diagram-1.svg");
  });

  it("keeps a name with dots and drops only the extension", () => {
    expect(diagramFileName("notes.v2.markdown", 3)).toBe("notes.v2-diagram-3.svg");
  });
});
