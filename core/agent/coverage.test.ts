import { expect, it } from "vitest";
import { describeCoverage } from "./coverage.js";
it("reports the unresolved pages instead of treating row existence as readiness", () => {
  expect(describeCoverage({ provenance: [{ page: 1, status: "read" }, { page: 2, status: "unresolved" }] })).toEqual({ indexStatus: "incomplete", unresolvedPageCount: 1 });
});
it("reports unknown coverage for legacy provenance", () => {
  expect(describeCoverage(null)).toEqual({ indexStatus: "unknown", unresolvedPageCount: null });
});
