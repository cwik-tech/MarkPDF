import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadCuratedTokenCounter, TokenizerUnavailableError, bundledTokenizerDir } from "./tokenizers.js";

/**
 * Counting tokens against the bundled artifacts.
 *
 * The artifacts are bundled rather than fetched so chunk boundaries never depend on the network:
 * the same document must chunk identically offline, or `semanticChunkingVersion` could not
 * describe the difference between two indexes.
 */

/** A faithful copy of the real bundle, so each case below differs in exactly one file. */
function seedBundle(): string {
  const dir = mkdtempSync(join(tmpdir(), "markpdf-tok-bundle-"));
  for (const file of readdirSync(bundledTokenizerDir())) {
    copyFileSync(join(bundledTokenizerDir(), file), join(dir, file));
  }
  return dir;
}

/**
 * Load with a hand-written configuration whose hash is computed to match.
 *
 * The recorded hash pins the real artifact, so every check after the byte comparison would be
 * unobservable without this. Supplying a matching hash for a deliberately wrong configuration is
 * what makes those checks provable.
 */
async function loadWithConfig(config: unknown): Promise<unknown> {
  const dir = seedBundle();
  const body = JSON.stringify(config);
  const hash = createHash("sha256").update(body).digest("hex");
  writeFileSync(join(dir, `${hash}.tokenizer_config.json`), body);
  try {
    return await loadCuratedTokenCounter({ directory: dir, cache: false, configHash: hash });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let count: (text: string) => number;

beforeAll(async () => {
  const counter = await loadCuratedTokenCounter();
  count = (text: string) => counter.count(text);
}, 60_000);

describe("counting tokens for the embedding budget", () => {
  it("counts only the text, not the tokenizer's own framing tokens", () => {
    // `encode` wraps every sequence in [CLS] … [SEP] by default, so counting its output directly
    // adds two to every measurement. Those two are already reserved by SPECIAL_TOKEN_ALLOWANCE,
    // and counting them twice would make every chunk two tokens smaller than the budget allows
    // while the code claimed otherwise.
    expect(count("")).toBe(0);
    expect(count("hello")).toBe(1);
    expect(count("hello world")).toBe(2);
  });

  it("counts more tokens for more text", () => {
    const short = count("Revenue by segment");
    const long = count("Revenue by segment across every region and product line in the portfolio");
    expect(long).toBeGreaterThan(short);
  });

  it("counts a table row's pipes and digits, which a word count would miss entirely", () => {
    // The reason a word count cannot stand in: markup and numerals cost tokens.
    const row = "|Enterprise|1204|1318|";
    expect(count(row)).toBeGreaterThan(row.split(/\s+/).length);
  });

  it("agrees with each distinct tokenizer measured on its own, and takes the largest", async () => {
    // A finding worth recording rather than assuming away: the two bundled tokenizers differ
    // only in their `truncation` and `padding` blocks, both of which this library ignores when
    // encoding. Vocabulary, normalizer, pre-tokenizer, post-processor and added tokens are
    // byte-identical, so they count every input the same and worst-case selection is currently
    // indistinguishable from any other. Mode selection is driven by the file hashes on purpose —
    // conservative when the files differ, whatever the reason they differ.
    const { countCoreTokensWithEachTokenizer } = await import("./tokenizers.js");
    const sample = "|Enterprise|1204|1318| The escape velocity of Deimos is five point six metres per second.";
    const perTokenizer = await countCoreTokensWithEachTokenizer(sample);

    expect(perTokenizer.length).toBe(2);
    expect(count(sample)).toBe(Math.max(...perTokenizer));
  }, 60_000);

  it("loads once and answers repeatedly without reconstructing anything", async () => {
    // 1,500 chunks against two tokenizers is 3,000 encode calls, which is fine. It would also be
    // 3,000 tokenizer constructions, which is not.
    const first = await loadCuratedTokenCounter();
    const second = await loadCuratedTokenCounter();
    expect(second).toBe(first);
  }, 60_000);
});

describe("refusing to count with artifacts it cannot trust", () => {
  it("names the missing tokenizer rather than falling back to an unverified count", async () => {
    const empty = mkdtempSync(join(tmpdir(), "markpdf-tok-missing-"));
    await expect(loadCuratedTokenCounter({ directory: empty, cache: false })).rejects.toThrow(
      TokenizerUnavailableError,
    );
    rmSync(empty, { recursive: true, force: true });
  });

  it("refuses an artifact whose contents do not match the recorded hash", async () => {
    // A silently wrong budget is the corruption this whole layer exists to prevent, so a
    // tampered or truncated artifact fails closed rather than counting with whatever is there.
    const dir = seedBundle();
    const { curatedTokenizers } = await import("./budget.js");
    writeFileSync(join(dir, `${curatedTokenizers[0]!.tokenizerHash}.tokenizer.json`), "{}");
    await expect(loadCuratedTokenCounter({ directory: dir, cache: false })).rejects.toThrow(/hash/i);
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("refuses to expose a counter when the bundled configuration is missing", async () => {
    // Through the public loader, not a helper: an integrity rule that only a direct helper call
    // enforces is not enforced, because production never makes that call.
    const dir = mkdtempSync(join(tmpdir(), "markpdf-tok-nocfg-"));
    const { curatedTokenizers } = await import("./budget.js");
    for (const entry of curatedTokenizers) {
      copyFileSync(
        join(bundledTokenizerDir(), `${entry.tokenizerHash}.tokenizer.json`),
        join(dir, `${entry.tokenizerHash}.tokenizer.json`),
      );
    }
    await expect(loadCuratedTokenCounter({ directory: dir, cache: false })).rejects.toThrow(
      TokenizerUnavailableError,
    );
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("refuses to expose a counter when the configuration's bytes do not match its hash", async () => {
    const dir = seedBundle();
    const { TOKENIZER_CONFIG_HASH } = await import("./budget.js");
    writeFileSync(join(dir, `${TOKENIZER_CONFIG_HASH}.tokenizer_config.json`), JSON.stringify({ model_max_length: 512 }));
    await expect(loadCuratedTokenCounter({ directory: dir, cache: false })).rejects.toThrow(/hash/i);
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("refuses a parsed artifact that is not an object", async () => {
    // Both files are `unknown` after JSON.parse. An array or a bare number would otherwise reach
    // the tokenizer constructor and fail somewhere less informative.
    const dir = seedBundle();
    const { curatedTokenizers } = await import("./budget.js");
    writeFileSync(join(dir, `${curatedTokenizers[0]!.tokenizerHash}.tokenizer.json`), "[1,2,3]");
    await expect(loadCuratedTokenCounter({ directory: dir, cache: false })).rejects.toThrow(
      TokenizerUnavailableError,
    );
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("refuses a configuration whose maximum length is not a positive whole number", async () => {
    for (const modelMaxLength of [0, -1, 2.5, "512", null, undefined]) {
      await expect(loadWithConfig({ model_max_length: modelMaxLength })).rejects.toThrow(
        /not a positive whole number/,
      );
    }
  }, 60_000);

  it("refuses a configuration that disagrees with any recorded catalogue limit", async () => {
    await expect(loadWithConfig({ model_max_length: 256 })).rejects.toThrow(
      /Catalogue records model_max_length 512/,
    );
  }, 60_000);

  it("refuses a configuration that parses to something other than an object", async () => {
    await expect(loadWithConfig([1, 2, 3])).rejects.toThrow(/must be a JSON object/);
    await expect(loadWithConfig(512)).rejects.toThrow(/must be a JSON object/);
  }, 60_000);

  it("verifies the recorded maximum length against the bundled configuration", async () => {
    // The one number that would otherwise be recalled rather than checked. Bundling the
    // configuration and reading it at load time means the recorded 512 is verified against an
    // artifact, not trusted.
    const { verifyRecordedMaxLength } = await import("./tokenizers.js");
    await expect(verifyRecordedMaxLength()).resolves.toBe(512);
  }, 60_000);

  it("refuses when the bundled configuration disagrees with the recorded maximum length", async () => {
    const dir = mkdtempSync(join(tmpdir(), "markpdf-tok-cfg-"));
    const { TOKENIZER_CONFIG_HASH } = await import("./budget.js");
    writeFileSync(join(dir, `${TOKENIZER_CONFIG_HASH}.tokenizer_config.json`), JSON.stringify({ model_max_length: 128 }));
    const { verifyRecordedMaxLength: verify } = await import("./tokenizers.js");
    await expect(verify(dir)).rejects.toThrow(TokenizerUnavailableError);
    rmSync(dir, { recursive: true, force: true });
  });

  it("knows where the bundled artifacts live", () => {
    expect(bundledTokenizerDir()).toMatch(/assets[/\\]tokenizers$/);
  });
});

describe("what actually truncates, measured rather than asserted", () => {
  it("ignores the truncation block inside a tokenizer file and truncates at model_max_length", async () => {
    // MiniLM's `tokenizer.json` declares `truncation.max_length: 128`. Taking that as the budget
    // would have made every chunk a quarter of the size it can be. This proves the claim through
    // the installed wrapper rather than by comment: a raw encode returns far more than 128
    // tokens, and the pipeline-style call — the same options `FeatureExtractionPipeline` uses —
    // truncates at 512, the `model_max_length` from the bundled configuration.
    const { loadCuratedTokenizerInstances } = await import("./tokenizers.js");
    const instances = await loadCuratedTokenizerInstances();
    const long = Array.from({ length: 600 }, (_unused, index) => `word${index}`).join(" ");

    for (const tokenizer of instances) {
      const raw = tokenizer.encode(long, { add_special_tokens: false });
      expect(raw.length).toBeGreaterThan(512);

      const encoded = tokenizer(long, { padding: true, truncation: true });
      expect(encoded.input_ids.dims.at(-1)).toBe(512);
      expect(tokenizer.model_max_length).toBe(512);
    }
  }, 60_000);
});
