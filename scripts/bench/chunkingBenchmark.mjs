/**
 * Before-and-after retrieval quality, run on demand rather than per pull request.
 *
 *   npm run build:core && node scripts/bench/chunkingBenchmark.mjs
 *
 * Plain JavaScript against `dist-core/`, so it needs no extra tool.
 *
 * The "before" side is the Phase 1 pipeline copied verbatim rather than imported, because
 * Phase 2 deleted it: the word-window chunker, and the pdf.js OCR arbitration rule that replaced
 * a page's text whenever its native layer held under 100 non-space characters. Copying is the
 * point — a benchmark importing the current code could only compare it against itself.
 *
 * Metrics, each defined where it is computed. All of them are computed against a fixed
 * ground-truthed fixture: every query has exactly one correct page, written down when the
 * fixture was built rather than taken from any run's output.
 */
import { chunkStructuredPages, budgetForProfile, toPlainText } from "../../dist-core/index/structuredChunking.js";
import { embeddingTokenBudget } from "../../dist-core/tokenize/budget.js";
import { loadCuratedTokenCounter } from "../../dist-core/tokenize/tokenizers.js";
import { createDeterministicEmbedder } from "../../dist-core/index/deterministicEmbedder.js";

/* ------------------------------------------------------------------ *
 * The fixture. Ground truth is declared here, never derived from a run.
 * ------------------------------------------------------------------ */

const TABLE_ROWS = [
  ["Consumer", "412", "455"],
  ["Education", "308", "331"],
  ["Government", "677", "702"],
  ["Enterprise", "1204", "1318"],
  ["Antarctic", "9317", "9420"],
];

const REGION_ROWS = Array.from({ length: 120 }, (_unused, index) => [
  `Region${index}`,
  String(index * 13),
  String(index * 17),
]);

const HEADER_CELLS = ["Segment", "Revenue 2025", "Revenue 2026"];
const asRow = (cells) => `|${cells.join("|")}|`;

/** What PDF Inspector produces: a GFM table. */
const asGfmTable = (rows) => [asRow(HEADER_CELLS), "|---|---|---|", ...rows.map(asRow)].join("\n");

/**
 * What pdf.js produced: the page's glyphs in reading order, with no structure at all.
 *
 * This is the representation the Phase 1 pipeline actually received, and giving the old chunker
 * GFM it could never have seen would have made the comparison meaningless — it would credit the
 * old algorithm with Firecrawl's output. The Electron journey makes the same point from the
 * other side: a stored chunk containing pipes can only have come from the new extractor.
 */
const asReadingOrder = (rows) => [...HEADER_CELLS, ...rows.flat()].join(" ");

/**
 * Six pages, mixed in kind.
 *
 * Page 4 is a genuine scan: a short stamp in the text layer, the real content only in OCR — the
 * case the old 100-character rule was written for, where both rules agree. Page 6 is the
 * divergence: readable, but under that bar, with an OCR candidate present.
 */
const SCAN_STAMP = "Invoice 20260823";
const SCAN_OCR = "Depreciation is recognised on a straight line basis over the asset's useful life.";

const SPARSE_NATIVE = "## Appendix A\n\nSource records retained.";
const SPARSE_OCR = "Appendix A source records retained for the audit trail of the reporting period.";

/**
 * Each page carries both representations: `flat` is what pdf.js gave Phase 1, `markdown` is what
 * PDF Inspector gives Phase 2. Each side of the comparison is driven by its own.
 */
const PAGES = [
  {
    page: 1,
    flat: "Annual Report Administrative preamble concerning departmental record keeping and audit review.",
    markdown: "# Annual Report\n\nAdministrative preamble concerning departmental record keeping and audit review.",
    ocr: null,
    extractorNeedsOcr: false,
  },
  {
    page: 2,
    flat: `Revenue by Segment ${asReadingOrder(TABLE_ROWS)}`,
    markdown: `## Revenue by Segment\n\n${asGfmTable(TABLE_ROWS)}`,
    ocr: null,
    extractorNeedsOcr: false,
  },
  {
    page: 3,
    flat: `Revenue by Region ${asReadingOrder(REGION_ROWS)}`,
    markdown: `## Revenue by Region\n\n${asGfmTable(REGION_ROWS)}`,
    ocr: null,
    extractorNeedsOcr: false,
  },
  // A genuine scan: a short stamp in the text layer, the real content only in OCR. Both rules
  // agree here, which is the case the old 100-character rule was written for.
  { page: 4, flat: SCAN_STAMP, markdown: SCAN_STAMP, ocr: SCAN_OCR, extractorNeedsOcr: true },
  {
    page: 5,
    flat: "Notes Enterprise revenue is discussed on page 2 of this report and nowhere else.",
    markdown: "## Notes\n\nEnterprise revenue is discussed on page 2 of this report and nowhere else.",
    ocr: null,
    extractorNeedsOcr: false,
  },
  // The divergence: readable, but under the old rule's 100-character bar, and an OCR candidate
  // exists because `runDocumentOcr` scans every page once the document is judged to need it.
  { page: 6, flat: "Appendix A Source records retained.", markdown: SPARSE_NATIVE, ocr: SPARSE_OCR, extractorNeedsOcr: false },
];

/** Query, and the one page that answers it. Written down with the fixture. */
const GROUND_TRUTH = [
  { query: "administrative preamble record keeping", page: 1 },
  { query: "Enterprise revenue by segment", page: 2 },
  { query: "Antarctic revenue", page: 2 },
  { query: "Region119 revenue", page: 3 },
  { query: "depreciation straight line useful life", page: 4 },
  { query: "where is enterprise revenue discussed", page: 5 },
  { query: "appendix source records audit trail", page: 6 },
];

/* ------------------------------------------------------------------ *
 * The Phase 1 pipeline, copied verbatim from commit 30c9b84.
 * ------------------------------------------------------------------ */

/** `src/pdf/pageText.ts`: OCR replaced a page whose native layer held under 100 non-space chars. */
function phase1PageText(pages) {
  return pages
    .map((page) => {
      const native = page.flat.replace(/\s+/g, " ").trim();
      const ocr = (page.ocr ?? "").replace(/\s+/g, " ").trim();
      const useOcr = native.replace(/\s/g, "").length < 100 && ocr.length > 0;
      return { page: page.page, text: useOcr ? ocr : native, source: useOcr ? "ocr" : "pdf" };
    })
    .filter((page) => page.text.length > 0);
}

/** `core/index/chunking.ts`: fixed overlapping word windows, no structure, no budget. */
function phase1Chunks(pages, chunkTokens = 420, overlapTokens = 70) {
  const stride = Math.max(1, chunkTokens - overlapTokens);
  const chunks = [];
  for (const page of pages) {
    const words = page.text.replace(/\s+/g, " ").trim().split(" ").filter((word) => word.length > 0);
    if (words.length === 0) continue;
    for (let start = 0; start < words.length; start += stride) {
      const text = words.slice(start, start + chunkTokens).join(" ");
      if (text.length >= 20) chunks.push({ page: page.page, text, embedText: text });
      if (start + chunkTokens >= words.length) break;
    }
  }
  return chunks;
}

/* ------------------------------------------------------------------ *
 * Metrics.
 * ------------------------------------------------------------------ */

/**
 * What the model actually sees.
 *
 * Cut at the **encoder payload limit**, not at the chunking target. Those are different numbers
 * and conflating them would misreport the old pipeline: the installed models truncate at
 * `model_max_length` less the special-token pair, while the profile target is what new chunks are
 * *built* to and is deliberately smaller. Simulating the cut at the target would charge the old
 * chunker for tokens the real model would have accepted.
 *
 * A chunk larger than the limit is not rejected at embed time — it is silently truncated, so
 * everything past the cut contributes nothing to its vector.
 */
function embeddedText(chunk, limit, count) {
  if (count(chunk.embedText) <= limit) return chunk.embedText;
  let size = chunk.embedText.length;
  while (size > 0 && count(chunk.embedText.slice(0, size)) > limit) size -= 1;
  return chunk.embedText.slice(0, size);
}

function dot(a, b) {
  let total = 0;
  for (let index = 0; index < a.length; index += 1) total += (a[index] ?? 0) * (b[index] ?? 0);
  return total;
}

/** Rank every chunk for one query, best first. */
async function rank(chunks, vectors, embedder, query) {
  const queryVector = await embedder.embed(query, "query");
  return chunks
    .map((chunk, index) => ({ page: chunk.page, score: dot(queryVector, vectors[index]) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * page accuracy@1 — the top-ranked chunk is on the correct page.
 * recall@5        — the correct page appears among the five best-ranked chunks.
 * MRR             — mean of 1/rank of the first chunk on the correct page, 0 if it never appears.
 *
 * **These are deterministic regression proxies, not evidence about the real model.** The embedder
 * here is `createDeterministicEmbedder`, a normalized bag of words. It says nothing about whether
 * the real weights rank usefully, whether ONNX Runtime initialises, or whether the score
 * threshold is calibrated — the plan is explicit that a replaced boundary cannot prove any of
 * that. What these figures do prove is that a change to chunking did not move retrieval
 * backwards under a fixed, reproducible scorer.
 */
async function rankingMetrics(chunks, encoderLimit, count, embedder) {
  const vectors = [];
  for (const chunk of chunks) vectors.push(await embedder.embed(embeddedText(chunk, encoderLimit, count), "passage"));

  let topOne = 0;
  let inFive = 0;
  let reciprocal = 0;

  for (const { query, page } of GROUND_TRUTH) {
    const ranked = await rank(chunks, vectors, embedder, query);
    if (ranked[0]?.page === page) topOne += 1;
    if (ranked.slice(0, 5).some((hit) => hit.page === page)) inFive += 1;
    const position = ranked.findIndex((hit) => hit.page === page);
    reciprocal += position === -1 ? 0 : 1 / (position + 1);
  }

  const total = GROUND_TRUTH.length;
  return {
    pageAccuracyAt1: Number((topOne / total).toFixed(3)),
    recallAt5: Number((inFive / total).toFixed(3)),
    mrr: Number((reciprocal / total).toFixed(3)),
  };
}

/**
 * intact-table rate — the share of logical rows that reach the model with their cells in order.
 *
 * Defined **without reference to any representation**, because the two sides carry the table
 * differently and comparing GFM syntax against reading-order text would measure the format
 * rather than the outcome. Both sides are reduced to plain text and a row counts when its cells
 * appear in order, contiguously.
 *
 * "Reaches the model" is the other load-bearing half: a row present in stored text but past a
 * truncation point contributes nothing to any vector, so it does not count.
 */
function visiblePlainText(chunks, encoderLimit, count) {
  // Once per chunk, never per row. `embeddedText` walks the text a character at a time calling
  // the tokenizer, so recomputing it inside a row scan turns a cheap report into hundreds of
  // truncations per chunk.
  return chunks.map((chunk) => toPlainText(embeddedText(chunk, encoderLimit, count)));
}

/** How many of `rows` appear, cells in order, in text already reduced once per chunk. */
function rowsReaching(visible, rows) {
  return rows.filter((cells) => visible.some((text) => text.includes(cells.join(" ")))).length;
}

function intactTableRate(visible, rows) {
  return Number((rowsReaching(visible, rows) / rows.length).toFixed(3));
}

/** A structural check kept separate: does anything preserve the table as a table? */
function gfmRowsPresent(chunks, rows) {
  return rows.filter((cells) => chunks.some((chunk) => chunk.embedText.includes(asRow(cells)))).length;
}

/** How the two OCR rules disagree about which pages to index from which source. */
function ocrArbitration(pages) {
  const phase1 = phase1PageText(pages);
  return pages.map((page) => {
    const before = phase1.find((entry) => entry.page === page.page)?.source ?? "dropped";
    // Phase 2: PDF Inspector decides. A page it reads keeps its native Markdown; a page it
    // cannot read uses the renderer's OCR candidate if one was offered.
    const after = !page.extractorNeedsOcr ? "pdf" : page.ocr === null ? "dropped" : "ocr";
    return { page: page.page, before, after, agrees: before === after };
  });
}

/* ------------------------------------------------------------------ */

const counter = await loadCuratedTokenCounter();
const count = (text) => counter.count(text);
/** What new chunks are built to: the user's profile choice, capped by the catalogue floor. */
const targetBudgetTokens = budgetForProfile("balanced");
/** Where the installed models actually truncate. Larger than the target, and not the same thing. */
const encoderPayloadLimitTokens = embeddingTokenBudget();
const embedder = createDeterministicEmbedder(384);

const beforePages = phase1PageText(PAGES);
const before = phase1Chunks(beforePages);

const afterPages = PAGES.map((page) => ({
  page: page.page,
  // Phase 2: the extractor's Markdown, or the OCR candidate for a page it could not read.
  markdown: page.extractorNeedsOcr ? (page.ocr ?? "") : page.markdown,
  source: page.extractorNeedsOcr ? "ocr" : "pdf",
}));
const after = chunkStructuredPages(afterPages, { budget: targetBudgetTokens, count });

const allRows = [...TABLE_ROWS, ...REGION_ROWS];
const beforeVisible = visiblePlainText(before, encoderPayloadLimitTokens, count);
const afterVisible = visiblePlainText(after, encoderPayloadLimitTokens, count);

const report = {
  fixture: { pages: PAGES.length, tableRows: allRows.length, queries: GROUND_TRUTH.length },
  targetBudgetTokens,
  encoderPayloadLimitTokens,
  ocrArbitration: {
    perPage: ocrArbitration(PAGES),
    disagreements: ocrArbitration(PAGES).filter((entry) => !entry.agrees).length,
  },
  before: {
    chunks: before.length,
    chunksOverTarget: before.filter((chunk) => count(chunk.embedText) > targetBudgetTokens).length,
    chunksOverEncoderLimit: before.filter((chunk) => count(chunk.embedText) > encoderPayloadLimitTokens).length,
    largestChunkTokens: Math.max(...before.map((chunk) => count(chunk.embedText))),
    intactTableRate: intactTableRate(beforeVisible, allRows),
    gfmRowsPreserved: gfmRowsPresent(before, allRows),
    ...(await rankingMetrics(before, encoderPayloadLimitTokens, count, embedder)),
  },
  after: {
    chunks: after.length,
    chunksOverTarget: after.filter((chunk) => count(chunk.embedText) > targetBudgetTokens).length,
    chunksOverEncoderLimit: after.filter((chunk) => count(chunk.embedText) > encoderPayloadLimitTokens).length,
    largestChunkTokens: Math.max(...after.map((chunk) => count(chunk.embedText))),
    intactTableRate: intactTableRate(afterVisible, allRows),
    gfmRowsPreserved: gfmRowsPresent(after, allRows),
    ...(await rankingMetrics(after, encoderPayloadLimitTokens, count, embedder)),
  },
};

/* ------------------------------------------------------------------ *
 * A separate stress scenario, reported separately.
 *
 * One table far larger than any budget, on one page. The six-page fixture measures a realistic
 * mixed document; this measures the failure mode at the scale where it dominates, and exists so
 * that figures quoted elsewhere are reproducible from this script rather than remembered.
 * ------------------------------------------------------------------ */

const STRESS_ROWS = Array.from({ length: 400 }, (_unused, index) => [
  `Region${index}`,
  String(index * 13),
  String(index * 17),
]);

const stressBefore = phase1Chunks([{ page: 1, text: asReadingOrder(STRESS_ROWS), source: "pdf" }]);
const stressAfter = chunkStructuredPages(
  [{ page: 1, markdown: asGfmTable(STRESS_ROWS), source: "pdf" }],
  { budget: targetBudgetTokens, count },
);
const stressBeforeVisible = visiblePlainText(stressBefore, encoderPayloadLimitTokens, count);
const stressAfterVisible = visiblePlainText(stressAfter, encoderPayloadLimitTokens, count);

const stressSide = (chunks, visible) => ({
  chunks: chunks.length,
  chunksOverTarget: chunks.filter((chunk) => count(chunk.embedText) > targetBudgetTokens).length,
  chunksOverEncoderLimit: chunks.filter((chunk) => count(chunk.embedText) > encoderPayloadLimitTokens).length,
  largestChunkTokens: Math.max(...chunks.map((chunk) => count(chunk.embedText))),
  rowsReachingTheModel: rowsReaching(visible, STRESS_ROWS),
});

report.stress = {
  rows: STRESS_ROWS.length,
  before: stressSide(stressBefore, stressBeforeVisible),
  after: stressSide(stressAfter, stressAfterVisible),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
