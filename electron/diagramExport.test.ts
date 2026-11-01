import { describe, expect, it } from "vitest";
import { MAX_DIAGRAM_SVG_LENGTH, diagramSaveRequest } from "./diagramExport.js";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><g/></svg>';

/*
 * The window asks the main process to save a diagram, so both arguments arrive over IPC as
 * `unknown`. The main process shows the save dialog and writes the file, and it decides what
 * it is prepared to write.
 */
describe("a request to save a diagram", () => {
  it("accepts an SVG document and the name to offer for it", () => {
    expect(diagramSaveRequest("plan-diagram-1.svg", SVG)).toEqual({
      fileName: "plan-diagram-1.svg",
      svg: SVG,
    });
  });

  it("accepts an SVG document that starts with an XML declaration", () => {
    const declared = `<?xml version="1.0" encoding="UTF-8"?>\n${SVG}`;
    expect(diagramSaveRequest("a.svg", declared)?.svg).toBe(declared);
  });

  it("offers only a file name, never a folder the window chose", () => {
    expect(diagramSaveRequest("../../Library/LaunchAgents/x.svg", SVG)?.fileName).toBe("x.svg");
    expect(diagramSaveRequest("C:\\Users\\reader\\x.svg", SVG)?.fileName).toBe("x.svg");
  });

  it("gives the offered name the SVG extension", () => {
    expect(diagramSaveRequest("plan", SVG)?.fileName).toBe("plan.svg");
    expect(diagramSaveRequest("", SVG)?.fileName).toBe("diagram.svg");
    expect(diagramSaveRequest(42, SVG)?.fileName).toBe("diagram.svg");
  });

  it("refuses content that is not an SVG document", () => {
    for (const content of [42, null, "", "#!/bin/sh\nrm -rf ~", "<html><svg></svg></html>"]) {
      expect(diagramSaveRequest("a.svg", content), String(content)).toBeNull();
    }
  });

  it("refuses content larger than a diagram can be", () => {
    const padding = " ".repeat(MAX_DIAGRAM_SVG_LENGTH);
    expect(diagramSaveRequest("a.svg", `${SVG}${padding}`)).toBeNull();
  });
});
