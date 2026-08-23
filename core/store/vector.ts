import { StoreDataError } from "./errors.js";

/** Embeddings are stored as raw little-endian float32; dimensionality is carried out of band. */
export function vectorToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

/**
 * Read a stored vector back.
 *
 * The sql.js implementation did this unchecked. A blob whose length disagreed with the recorded
 * `dimensions` silently produced a short vector, and the old similarity function compared over
 * `Math.min(a.length, b.length)` — so a corrupt row scored as a partial match rather than
 * failing. Validate instead.
 */
export function blobToVector(blob: Uint8Array, dimensions: number): Float32Array {
  if (blob.byteLength % 4 !== 0) {
    throw new StoreDataError(`Embedding blob length ${blob.byteLength} is not a whole number of float32 values.`);
  }
  const length = blob.byteLength / 4;
  if (length !== dimensions) {
    throw new StoreDataError(`Embedding blob holds ${length} values but the row records ${dimensions} dimensions.`);
  }
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

/**
 * Vectors are stored normalized (`normalize: true` at embed time), so in practice this is a dot
 * product. It is written in full because a future model configuration could stop normalizing,
 * and a silently-wrong similarity is worse than a slightly slower one.
 *
 * `entries()` yields each element as a `number`, which is what lets this run under
 * `noUncheckedIndexedAccess` without a non-null assertion.
 */
export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) return 0;

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (const [index, leftValue] of left.entries()) {
    const rightValue = right[index];
    if (rightValue === undefined) return 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}
