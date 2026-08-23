import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { curatedTokenizers, distinctTokenizerHashes, TOKENIZER_CONFIG_HASH } from "./budget.js";

/** Raised when the bundled artifacts are missing or do not match what was measured. */
export class TokenizerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenizerUnavailableError";
  }
}

/**
 * The tokenizer this module uses, as the package itself declares it.
 *
 * Imported as a type rather than restated: `PreTrainedTokenizer` is exported, carries `encode`
 * and `model_max_length`, and its constructor is declared `(tokenizerJSON: any,
 * tokenizerConfig: any)`. There is nothing here that needs an assertion.
 */
export type PreTrainedTokenizerInstance = import("@huggingface/transformers").PreTrainedTokenizer;

export interface TokenCounter {
  /** The largest token count across every distinct curated tokenizer. */
  count(text: string): number;
}

/**
 * Where the bundled artifacts live.
 *
 * Bundled rather than fetched, deliberately. Fetching would make chunk boundaries depend on the
 * network, so the same document could chunk differently on a machine that happened to be
 * offline — and `semanticChunkingVersion` could not describe that difference. Bundling also
 * makes the recorded hash meaningful: it is the hash of the file that actually counts tokens at
 * run time, not of something downloaded later.
 */
export function bundledTokenizerDir(): string {
  // `dist-core/tokenize/` → repository root → `assets/tokenizers`.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "tokenizers");
}

interface LoadOptions {
  directory?: string;
  /** Off for tests that deliberately point at a broken directory. */
  cache?: boolean;
  /** Defaults to the recorded hash. See `verifiedConfig` for why this is overridable. */
  configHash?: string;
}

let cached: Promise<TokenCounter> | null = null;

/** A real predicate, so narrowing is the compiler's conclusion rather than an assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Both bundled files are `unknown` after parsing; neither reaches the tokenizer unchecked. */
function requireJsonObject(path: string, raw: Buffer): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new TokenizerUnavailableError(`Bundled artifact at ${path} is not valid JSON.`);
  }
  if (!isRecord(parsed)) {
    throw new TokenizerUnavailableError(`Bundled artifact at ${path} must be a JSON object.`);
  }
  return parsed;
}

async function readVerified(directory: string, fileName: string, hash: string): Promise<Record<string, unknown>> {
  const path = join(directory, fileName);
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch {
    throw new TokenizerUnavailableError(
      `Bundled artifact ${fileName} is missing from ${directory}. Chunking cannot proceed without it: an unmeasured budget truncates silently.`,
    );
  }

  const actual = createHash("sha256").update(raw).digest("hex");
  if (actual !== hash) {
    throw new TokenizerUnavailableError(
      `Bundled artifact at ${path} has hash ${actual}, not the recorded ${hash}. Refusing to count with an artifact that is not the one measured.`,
    );
  }
  return requireJsonObject(path, raw);
}

/**
 * Read the bundled configuration, check its bytes, and check what it says.
 *
 * Both halves matter. The hash proves the file is the one that was measured; reading
 * `model_max_length` back and comparing it against every recorded catalogue limit proves the
 * catalogue is still describing it. A budget that rests on a written-down number rather than an
 * artifact is exactly how silent truncation gets in.
 */
/** A configuration that has passed every check, with the one value we read pulled out. */
export interface VerifiedTokenizerConfig {
  /** The parsed configuration, handed to the tokenizer constructor unchanged. */
  raw: Record<string, unknown>;
  /** `model_max_length`, proven to be a positive whole number matching the catalogue. */
  maxLength: number;
}

async function verifiedConfig(
  directory: string,
  configHash: string = TOKENIZER_CONFIG_HASH,
): Promise<VerifiedTokenizerConfig> {
  // `configHash` is overridable for one reason: with the recorded hash pinned, every artifact
  // that passes the byte check necessarily carries the recorded values, so the checks *after* it
  // could never be observed failing. Supplying a matching hash for a deliberately wrong config
  // is what lets those rules be proved rather than assumed.
  const config = await readVerified(directory, `${configHash}.tokenizer_config.json`, configHash);

  const maxLength = config.model_max_length;
  if (typeof maxLength !== "number" || !Number.isInteger(maxLength) || maxLength < 1) {
    throw new TokenizerUnavailableError(
      `Bundled tokenizer configuration has model_max_length ${String(maxLength)}, which is not a positive whole number.`,
    );
  }

  // Every applicable recorded limit, not just the smallest: a catalogue entry that disagreed
  // with the artifact would otherwise stay wrong as long as some other entry matched.
  for (const entry of curatedTokenizers) {
    if (entry.modelMaxLength !== maxLength) {
      throw new TokenizerUnavailableError(
        `Catalogue records model_max_length ${entry.modelMaxLength} for ${entry.modelId}, but the bundled configuration says ${maxLength}.`,
      );
    }
  }
  return { raw: config, maxLength };
}

async function loadOne(
  directory: string,
  hash: string,
  config: VerifiedTokenizerConfig,
): Promise<PreTrainedTokenizerInstance> {
  const json = await readVerified(directory, `${hash}.tokenizer.json`, hash);
  const { PreTrainedTokenizer } = await import("@huggingface/transformers");
  // Constructed from the same two artifacts the installed runtime uses, so the counting
  // tokenizer and the embedding tokenizer are the same thing. Network-free, and `env` is left
  // alone — it is a process-wide singleton and toggling it per call would race a concurrent
  // model download.
  return new PreTrainedTokenizer(json, config.raw);
}

/**
 * Load every distinct curated tokenizer once and count with all of them.
 *
 * Once, because 1,500 chunks against two tokenizers is 3,000 encode calls — fine — and would
 * also be 3,000 tokenizer constructions, which is not. Worst-case across them, because equal
 * `model_max_length` values do not make two tokenizers agree on what a given string costs.
 */
export async function loadCuratedTokenCounter(options: LoadOptions = {}): Promise<TokenCounter> {
  const useCache = options.cache !== false && options.directory === undefined;
  if (useCache && cached !== null) return cached;

  const directory = options.directory ?? bundledTokenizerDir();
  const build = (async (): Promise<TokenCounter> => {
    // The configuration is verified inside the same build, before any encoder exists. Failing
    // closed here means no caller can ever hold a counter built on an unverified budget.
    const config = await verifiedConfig(directory, options.configHash);
    const tokenizers = await Promise.all(
      distinctTokenizerHashes(curatedTokenizers).map((hash) =>
        loadOne(directory, hash, config),
      ),
    );
    return {
      count: (text) => {
        let largest = 0;
        for (const tokenizer of tokenizers) {
          largest = Math.max(largest, tokenizer.encode(text, { add_special_tokens: false }).length);
        }
        return largest;
      },
    };
  })();

  if (useCache) {
    cached = build.catch((error: unknown) => {
      cached = null; // a failed load must not poison every later attempt
      throw error;
    });
    return cached;
  }
  return build;
}

/** The recorded limit, re-read from the bundled configuration. Verified, never recalled. */
export async function verifyRecordedMaxLength(directory: string = bundledTokenizerDir()): Promise<number> {
  // No cast: `verifiedConfig` narrows the value while it validates it, so the number it returns
  // is a number by construction rather than by assertion.
  return (await verifiedConfig(directory)).maxLength;
}

/** Each distinct tokenizer, constructed from the verified bundle. */
export async function loadCuratedTokenizerInstances(
  directory: string = bundledTokenizerDir(),
): Promise<PreTrainedTokenizerInstance[]> {
  const config = await verifiedConfig(directory);
  return Promise.all(
    distinctTokenizerHashes(curatedTokenizers).map((hash) =>
      loadOne(directory, hash, config),
    ),
  );
}

/**
 * Each distinct tokenizer's own count for one string, in catalogue order.
 *
 * Exposed so a test can show what worst-case selection is choosing between, rather than
 * asserting the maximum of numbers it cannot see.
 */
export async function countCoreTokensWithEachTokenizer(
  text: string,
  directory: string = bundledTokenizerDir(),
): Promise<number[]> {
  const tokenizers = await loadCuratedTokenizerInstances(directory);
  return tokenizers.map((tokenizer) => tokenizer.encode(text, { add_special_tokens: false }).length);
}
