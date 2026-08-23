import { describe, expect, it } from "vitest";
import { shouldUseDeterministicEmbedder } from "./embedderSelection.js";

const VALID = { MARKPDF_E2E_EMBEDDER: "deterministic", MARKPDF_TEST_USER_DATA: "/tmp/ud" };

describe("choosing between the real model and the deterministic stand-in", () => {
  it("uses the real model in a packaged application, whatever the environment says", () => {
    // The failure this prevents is a released build indexing with meaningless vectors.
    expect(shouldUseDeterministicEmbedder({ isPackaged: true, env: VALID })).toBe(false);
  });

  it("uses the real model when no opt-in flag is present", () => {
    expect(shouldUseDeterministicEmbedder({
      isPackaged: false, env: { MARKPDF_TEST_USER_DATA: "/tmp/ud" },
    })).toBe(false);
  });

  it("requires the exact opt-in token rather than any truthy value", () => {
    for (const value of ["1", "true", "yes", "Deterministic", "deterministic ", ""]) {
      expect(shouldUseDeterministicEmbedder({
        isPackaged: false,
        env: { MARKPDF_E2E_EMBEDDER: value, MARKPDF_TEST_USER_DATA: "/tmp/ud" },
      })).toBe(false);
    }
  });

  it("refuses to substitute unless a test user-data directory isolates the index", () => {
    expect(shouldUseDeterministicEmbedder({
      isPackaged: false, env: { MARKPDF_E2E_EMBEDDER: "deterministic" },
    })).toBe(false);
    expect(shouldUseDeterministicEmbedder({
      isPackaged: false, env: { MARKPDF_E2E_EMBEDDER: "deterministic", MARKPDF_TEST_USER_DATA: "" },
    })).toBe(false);
  });

  it("substitutes only when unpackaged, explicitly opted in, and pointed at a test directory", () => {
    expect(shouldUseDeterministicEmbedder({ isPackaged: false, env: VALID })).toBe(true);
  });
});
