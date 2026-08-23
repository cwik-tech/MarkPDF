import { describe, expect, it } from "vitest";
import { EXIT_CODE } from "./exit.js";

/**
 * The exit codes, written out from the plan rather than read back from the implementation.
 *
 * These numbers are the contract an agent's shell script reads. Changing one silently changes
 * what every caller concludes, so the table is asserted literally.
 */
describe("the exit code contract", () => {
  it("matches the documented meanings exactly", () => {
    expect(EXIT_CODE).toEqual({
      success: 0,
      // Not from the plan's table, which starts at 2. Named so that an unexpected failure does
      // not have to borrow a code that already means something.
      unexpected: 1,
      usage: 2,
      notFound: 3,
      notIndexed: 4,
      accessDenied: 5,
      parseFailed: 6,
      partialFailure: 7,
      missingDependency: 8,
      indexBusy: 9,
      appUnavailable: 69,
      interrupted: 130,
    });
  });
});
