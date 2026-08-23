import type { IndexDocumentResult, IndexedDocumentResult } from "./indexDocument.js";

/**
 * Assert that a run actually indexed, and narrow to the shape carrying identifiers.
 *
 * A cancelled result has no content hash and no document id, so a test reaching for one has
 * either mis-set up its scenario or found a real regression. Failing here names which, instead
 * of surfacing later as a comparison against `undefined`.
 *
 * The `.test-support.ts` suffix keeps this out of `dist-core/`.
 */
export function expectIndexed(result: IndexDocumentResult): IndexedDocumentResult {
  if (result.status === "cancelled") {
    throw new Error("Expected the run to index, but it reported cancelled.");
  }
  return result;
}
