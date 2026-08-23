/**
 * Read an embedding out of the tensor a Transformers pipeline returns.
 *
 * The declared type of `Tensor.data` is `AnyTypedArray | any[]`, so it is genuinely unknown at
 * compile time and has to be narrowed rather than asserted. The width comes from the last axis
 * of `dims`, not from `size`: `size` is the product of every axis, so on a batched call it
 * would silently accept a vector of the wrong width.
 *
 * Getting this wrong stores vectors under a dimension label they do not match, which makes an
 * index quietly unsearchable rather than loudly broken.
 */
export class EmbeddingShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingShapeError";
  }
}

type NumericTypedArray =
  | Float32Array | Float64Array
  | Int8Array | Uint8Array | Uint8ClampedArray
  | Int16Array | Uint16Array
  | Int32Array | Uint32Array;

/**
 * A real type guard rather than an assertion. `Tensor.data` is declared as
 * `AnyTypedArray | any[]`, which includes BigInt arrays and plain arrays, so narrowing to the
 * numeric typed arrays is the only honest way to reach `.length` and numeric values.
 */
function isNumericTypedArray(value: unknown): value is NumericTypedArray {
  return (
    value instanceof Float32Array || value instanceof Float64Array ||
    value instanceof Int8Array || value instanceof Uint8Array || value instanceof Uint8ClampedArray ||
    value instanceof Int16Array || value instanceof Uint16Array ||
    value instanceof Int32Array || value instanceof Uint32Array
  );
}

export interface EmbeddingTensorLike {
  data: unknown;
  dims: readonly number[];
}

export function toEmbeddingVector(tensor: EmbeddingTensorLike, expectedDimensions: number): Float32Array {
  const width = tensor.dims.at(-1);
  if (width === undefined) {
    throw new EmbeddingShapeError("The embedding model returned a tensor with no dimensions.");
  }
  if (width !== expectedDimensions) {
    throw new EmbeddingShapeError(
      `The embedding model is declared ${expectedDimensions} dimensions but returned ${width}.`,
    );
  }

  const values = tensor.data;
  if (!isNumericTypedArray(values)) {
    throw new EmbeddingShapeError("The embedding model returned data that is not a typed array.");
  }
  if (values.length !== width) {
    throw new EmbeddingShapeError(
      `The embedding model returned ${values.length} values for a ${width}-dimension vector.`,
    );
  }
  return Float32Array.from(values);
}
