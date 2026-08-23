/**
 * What was measured about each curated model's tokenizer, and the budget that follows from it.
 *
 * Every number here came from loading the artifact in `assets/tokenizers/` and reading it —
 * never from a model card or from memory. Recalling a limit is exactly the failure this layer
 * exists to prevent, because a budget that is wrong by a few tokens produces silent truncation
 * rather than an error.
 */
export interface TokenizerRecord {
  modelId: string;
  /** sha256 of the bundled `tokenizer.json` this model uses. */
  tokenizerHash: string;
  /** `model_max_length` read from the model's own `tokenizer_config.json`. */
  modelMaxLength: number;
}

/** When the values below were measured, and against which package version. */
export const tokenizerMeasurement = {
  date: "2026-08-23",
  transformersVersion: "4.2.0",
  /** Upstream revisions the bundled artifacts were taken from. */
  revisions: {
    "Xenova/bge-small-en-v1.5": "ea104dacec62c0de699686887e3f920caeb4f3e3",
    "Xenova/all-MiniLM-L6-v2": "751bff37182d3f1213fa05d7196b954e230abad9",
    "Xenova/bge-base-en-v1.5": "4d6cd88e18e51a5e020c2c305726d76ada9c03cf",
  },
} as const;

/**
 * Measured 2026-08-23.
 *
 * `bge-small` and `bge-base` share one `tokenizer.json` byte for byte; `all-MiniLM-L6-v2` has a
 * different file. All three report `model_max_length` 512. Equal limits do **not** make the
 * tokenizers interchangeable — normalizer, casing and unknown-token handling can each change how
 * many tokens a given string costs — which is why the hashes, not the limits, choose the
 * counting mode.
 */
export const curatedTokenizers: readonly TokenizerRecord[] = [
  {
    modelId: "Xenova/bge-small-en-v1.5",
    tokenizerHash: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
    modelMaxLength: 512,
  },
  {
    modelId: "Xenova/all-MiniLM-L6-v2",
    tokenizerHash: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
    modelMaxLength: 512,
  },
  {
    modelId: "Xenova/bge-base-en-v1.5",
    tokenizerHash: "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
    modelMaxLength: 512,
  },
];

/**
 * Room reserved for the tokenizer's own framing tokens.
 *
 * BERT-family tokenizers wrap every sequence in `[CLS]` … `[SEP]`, and both count against
 * `model_max_length`. Budgeting the full limit would overflow by exactly two tokens on every
 * chunk that came close to it.
 */
export const SPECIAL_TOKEN_ALLOWANCE = 2;

/**
 * sha256 of the bundled `tokenizer_config.json`, which is byte-identical across all three
 * curated models. It is bundled and hashed so `modelMaxLength` above is verified against an
 * artifact at load time rather than trusted as a written-down number.
 */
export const TOKENIZER_CONFIG_HASH = "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3";

/** The breadcrumb may take at most this share of the budget. */
export const BREADCRUMB_TOKEN_SHARE = 0.15;

/**
 * How token counts are obtained.
 *
 * `canonical` would mean every curated tokenizer is the same file, so one count serves all.
 * `worst-case` means they are not, so a candidate chunk must be measured against each distinct
 * one and must fit the largest count. The hashes decide; nothing assumes.
 */
export function countingMode(records: readonly TokenizerRecord[] = curatedTokenizers): "canonical" | "worst-case" {
  return distinctTokenizerHashes(records).length === 1 ? "canonical" : "worst-case";
}

/** Each distinct bundled tokenizer, once. Two models sharing a file are measured together. */
export function distinctTokenizerHashes(records: readonly TokenizerRecord[] = curatedTokenizers): string[] {
  return [...new Set(records.map((entry) => entry.tokenizerHash))];
}

/**
 * The number of tokens an assembled embedding input may occupy.
 *
 * The floor across the catalogue, not the active model's own limit. Chunk text has to stay
 * model-independent: `document_chunks.id` is a primary key with no model column, while
 * `chunk_embeddings` is keyed by model, which is precisely what makes switching models a
 * re-embed rather than a re-chunk. Sizing chunks to the active model would break that.
 */
export function embeddingTokenBudget(records: readonly TokenizerRecord[] = curatedTokenizers): number {
  const smallest = Math.min(...records.map((entry) => entry.modelMaxLength));
  return smallest - SPECIAL_TOKEN_ALLOWANCE;
}

/**
 * How many tokens the heading breadcrumb may occupy.
 *
 * Floored, and never the whole budget however small the budget gets — a breadcrumb that crowded
 * out the body would describe a chunk with nothing in it.
 */
export function breadcrumbTokenAllowance(budget: number): number {
  return Math.min(Math.floor(budget * BREADCRUMB_TOKEN_SHARE), Math.max(0, budget - 1));
}
