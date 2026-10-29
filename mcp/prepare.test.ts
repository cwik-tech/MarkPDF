import { expect, it } from "vitest";
import { TOOLS } from "./toolSchemas.js";
it("offers explicit PDF preparation with a required path", () => {
  const tool = TOOLS.find((entry) => entry.name === "prepare_document");
  expect(tool).toMatchObject({ name: "prepare_document", inputSchema: { required: ["path"], additionalProperties: false } });
});
