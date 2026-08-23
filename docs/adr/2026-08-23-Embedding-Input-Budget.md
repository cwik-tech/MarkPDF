# The embedding input budget

## Status

Accepted

## Context

Feature extraction in the installed `@huggingface/transformers` 4.2.0 truncates silently.
`src/pipelines/feature-extraction.js:89-92` calls the tokenizer with `{ padding: true,
truncation: true }` and no `max_length`, and the pipeline exposes no way to pass one;
`src/tokenization_utils.js:405,428` then clamps to the tokenizer's `model_max_length`. Anything
longer is cut, nothing is raised, and the tail contributes nothing to the vector.

Phase 1's chunking was a word window: `contextual` was 640 words plus a breadcrumb, against
models whose limits are counted in hundreds of tokens. Ordinary prose had been overflowing since
before this programme started.

Measured by the **400-row stress scenario** of `scripts/bench/chunkingBenchmark.mjs` — one
oversized table on one page — with each side driven by its own representation: a pdf.js
reading-order string for the Phase 1 chunker, PDF Inspector Markdown for Phase 2. Before: 4
chunks, three of them past the encoder's 510-token payload limit, largest **1,052 tokens**, of
which **287 of 400 rows reached the model**. After: 12 chunks, largest 420, none over the limit,
**400 of 400**.

The script's other scenario, a six-page mixed fixture, reports different figures for a different
document — 14 chunks and a largest of 415 after. The two are not interchangeable, and every
figure quoted anywhere should name which scenario produced it.

Two numbers are kept distinct throughout and must not be conflated. The **chunking target** is
what new chunks are built to — the user's profile choice, capped by the catalogue floor, 420 for
`balanced`. The **encoder payload limit** is where the installed models actually truncate:
`min(model_max_length)` less the special-token pair, 510. Simulating truncation at the target
would charge the old chunker for tokens the model would have accepted.

## Decision

**One budget in tokens, measured with the real tokenizer, covering the whole assembled input** —
breadcrumb, separator, body and the tokenizer's own framing tokens. Nothing estimates tokens from
word or character counts.

**Measured 2026-08-23 against transformers 4.2.0:**

| Model | Revision | `tokenizer.json` sha256 (first 16) | `model_max_length` |
| --- | --- | --- | --- |
| `Xenova/bge-small-en-v1.5` | `ea104dac…` | `d241a60d5e8f04cc` | 512 |
| `Xenova/all-MiniLM-L6-v2` | `751bff37…` | `da0e79933b9ed517` | 512 |
| `Xenova/bge-base-en-v1.5` | `4d6cd88e…` | `d241a60d5e8f04cc` | 512 |

Bundled `tokenizer_config.json` sha256: `9261e7d79b44c819…` (identical across all three).

**The hashes do not all agree, so worst-case measurement is the mode in force.** Two distinct
files for three models; a candidate chunk is measured against each and must fit the largest
count. Equal limits do not make tokenizers interchangeable.

**Budget = min(512) − 2 = 510**, the two being the `[CLS]`/`[SEP]` pair. Counting uses
`add_special_tokens: false`, or that pair would be subtracted twice.

**The floor is the catalogue's, not the active model's.** `document_chunks.id` is a primary key
with no model column while `chunk_embeddings` is keyed by model — one chunk of text, one vector
per model — which is exactly what makes switching models a re-embed rather than a re-chunk.
Sizing chunks to the active model would break that. Chunk identity stays model-blind for the same
reason.

**Presets become targets under the ceiling.** `budgetForProfile` is `min(catalogueBudget,
preset.chunkTokens)`, so precise/balanced/contextual still change chunk size and `contextual` at
640 is capped at 510 rather than honoured and silently truncated.

**Tokenizers are bundled, hash-verified and loaded once.** Fetching would make chunk boundaries
depend on the network, so the same document could chunk differently offline and
`semanticChunkingVersion` could not describe the difference. Bundling also makes the recorded
hash meaningful: it is the hash of the file that counts tokens at run time. A missing or
mismatched artifact raises `TokenizerUnavailableError`; the load fails closed before any encoder
is exposed, and the recorded 512 is re-read from the bundled configuration rather than trusted.

**The breadcrumb may take at most `BREADCRUMB_TOKEN_SHARE = 0.15`**, floored, and is trimmed
outside-in — the nearest heading carries the most signal and is dropped last.

## Consequences

- About 1.4 MB of bundled artifacts, deduplicated by hash. Against 133/90/438 MB of weights.
- `semanticChunkingVersion` rises to 2, so every stored chunk is invalidated and re-indexed
  lazily, one document at a time, on next open.
- Adding a model with a shorter context, or a different tokenizer hash, is another version bump.

## Verification

`core/tokenize/budget.test.ts` and `core/tokenize/tokenizers.test.ts` cover the catalogue, the
mode selection, the budget arithmetic and every integrity rule.
`core/index/truncationRetrieval.test.ts` proves the point end to end through `indexDocument` and
`searchDocument` against `createTruncatingEmbedder`, which cuts at the budget the chunker
promises to respect — the default deterministic embedder has no limit and would return an equally
confident vector for an input the real model had halved.

Mutation-proved: canonical mode forced; the smallest limit swapped for the largest; the
special-token allowance dropped; framing tokens counted twice; the breadcrumb allowance ignored
or trimmed inside-out; the hash, integer and catalogue-agreement checks removed; the tokenizer
built without its configuration; the mean taken instead of the worst case; and atomic oversized
tables restored, which fails both the budget and the retrieval proofs.

Two findings recorded rather than smoothed over. The two bundled tokenizers differ **only** in
their `truncation` and `padding` blocks, which this library ignores when encoding, so they count
identically — mode selection follows the hashes anyway, because "the files differ" is a fact and
"the difference does not matter today" is a judgement a future artifact could invalidate.
And MiniLM's `tokenizer.json` declares `truncation.max_length: 128`, which is **inert**: encoding
a 1,726-token string through it returned all 1,726 tokens. A budget of 128 would have been wrong
by a factor of four.

## Alternatives considered

- **Per-model chunking with a model-scoped chunk identity.** Rejected: `chunk_embeddings` exists
  precisely so switching models re-embeds rather than re-chunks.
- **Taking the minimum `model_max_length` as sufficient.** Rejected: equal limits do not imply
  equal counts.
- **Estimating tokens from word counts.** Rejected: cannot be safe at the boundary, which is the
  only place it matters.
- **Fetching tokenizers on demand.** Rejected: makes chunk boundaries network-dependent.
