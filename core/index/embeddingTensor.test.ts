import { describe, expect, it } from "vitest";
import { toEmbeddingVector } from "./embeddingTensor.js";

/** The shape Transformers returns: `.data` is typed `AnyTypedArray | any[]`, `.dims` is number[]. */
const tensor = (data: unknown, dims: number[]) => ({ data, dims });

describe("reading an embedding out of a model tensor", () => {
  it("accepts a well-formed float32 tensor and reports its width from the last axis", () => {
    const vector = toEmbeddingVector(tensor(Float32Array.from([0, 1, 0, 0]), [1, 4]), 4);
    expect(vector).toBeInstanceOf(Float32Array);
    expect(vector.length).toBe(4);
  });

  it("rejects a tensor whose width disagrees with the model's declared dimensions", () => {
    // Silently storing a 512-wide vector under a 384-dimension label is how an index becomes
    // quietly unsearchable, so this must fail at the provider rather than at read time.
    expect(() => toEmbeddingVector(tensor(Float32Array.from([1, 2, 3]), [1, 3]), 384)).toThrow(
      /declared 384 dimensions but returned 3/,
    );
  });

  it("rejects data that is not a typed array, which the declared type permits", () => {
    expect(() => toEmbeddingVector(tensor([1, 2, 3], [1, 3]), 3)).toThrow(/not a typed array/);
  });

  it("uses the last axis rather than the total element count, so batching cannot mislead it", () => {
    // `size` would be 8 here and would wrongly pass a 4-dimension check on a batch of two.
    expect(() => toEmbeddingVector(tensor(Float32Array.from([0, 1, 0, 0, 0, 0, 1, 0]), [2, 4]), 8)).toThrow(
      /declared 8 dimensions but returned 4/,
    );
  });

  it("rejects a tensor with no dimensions at all", () => {
    expect(() => toEmbeddingVector(tensor(Float32Array.from([1]), []), 1)).toThrow(/no dimensions/);
  });
});
