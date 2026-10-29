import { expect, it } from "vitest";
import { parsePreparationReply } from "./preparation.js";
it("rejects readiness without a document identity", () => {
  expect(() => parsePreparationReply({ status: "ready", save: "saved" })).toThrow("identity");
});
it("preserves a completed save when later stages fail", () => {
  expect(parsePreparationReply({ status: "failed", save: "saved", reason: "index unavailable" })).toEqual({ status: "failed", save: "saved", reason: "index unavailable" });
});
it("rejects malformed page coverage", () => {
  expect(() => parsePreparationReply({ status: "incomplete", save: "not_needed", unresolvedPages: [-1] })).toThrow("page");
});

it("rejects a non-PDF preparation target before launching a desktop", async () => {
  const { requirePreparationPath } = await import("./preparation.js");
  expect(() => requirePreparationPath("/tmp/report.md")).toThrow("PDF");
  expect(() => requirePreparationPath("relative.pdf")).toThrow("absolute");
  expect(requirePreparationPath("/tmp/report.PDF")).toBe("/tmp/report.PDF");
});
