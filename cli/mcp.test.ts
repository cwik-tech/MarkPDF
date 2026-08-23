import { describe, expect, it } from "vitest";
import { mcpEntryPoint } from "./mcp.js";

/**
 * `markpdf mcp` re-execs the bundled runtime on the MCP server's entry point. That entry point is
 * a sibling of the command line's own compiled output in both layouts this ships in — a checkout
 * and an `app.asar` — so the resolution is a pure function of where the command line itself lives.
 */
describe("mcpEntryPoint", () => {
  it("resolves beside the command line in a checkout", () => {
    expect(mcpEntryPoint("/work/markpdf/dist-cli/main.js")).toBe("/work/markpdf/dist-mcp/main.js");
  });

  it("resolves inside the same archive in a packaged build", () => {
    expect(mcpEntryPoint("/Applications/MarkPDF.app/Contents/Resources/app.asar/dist-cli/main.js")).toBe(
      "/Applications/MarkPDF.app/Contents/Resources/app.asar/dist-mcp/main.js",
    );
  });
});
