# Library search measurement

Date: 2026-10-31. Branch `cwik-tech/library-search`, uncommitted implementation on top of `2125a71`.

## What was measured

Command, run once through the machine-wide lock:

```
npm run build:core
heavy-run --label markpdf -- node scripts/bench/librarySearchBenchmark.mjs 10000,100000,500000 10
```

- Runtime: Node 24.21.0, `better-sqlite3` 13.0.3, SQLite 3.53.4, on this Mac. Wall time 7 min 34 s.
- Every write goes through the production store API, so the exact-word triggers ran.
- Vectors are random unit vectors with 384 dimensions. Text is 120 words from a synthetic vocabulary
  of 24,000 words with a skewed frequency, plus one unique token for each chunk. Document sizes are
  skewed: most documents are short, a few are very long.
- Latency is for `searchLibrary` with every document discoverable, 10 queries for each mode and kind
  of query, warm operating-system cache. **The query embedding is excluded.**
- "Without triggers" writes the same data into a store whose two exact-word triggers were dropped.
- The backfill starts from an emptied exact-word index, as an upgraded store has it.
- Peak resident memory is the benchmark process, which also generates the synthetic data. It is not a
  measure of the app's memory during a search.

## Results

| Measure | 10,000 chunks | 100,000 chunks | 500,000 chunks |
| --- | --- | --- | --- |
| Store size | 46 MB | 462 MB | 2,335 MB |
| Exact-word index in it | 5 MB | 45 MB | 224 MB |
| Store writes without triggers | 409 ms | 4,008 ms | 19,879 ms |
| Store writes with triggers | 1,044 ms | 10,913 ms | 60,172 ms |
| Backfill from empty, total | 650 ms | 7,768 ms | 42,562 ms |
| Longest backfill transaction | 61 ms | 232 ms | 368 ms |
| First query of the run, hybrid | 66 ms | 685 ms | 3,583 ms |
| Hybrid p95: rare / common / multi-word / no hit | 66 / 87 / 71 / 67 ms | 794 / 924 / 705 / 707 ms | 3,712 / 4,807 / 3,713 / 3,311 ms |
| Semantic p95 | 63 ms | 724 ms | 3,496 ms |
| Exact p95: rare / common / multi-word / no hit | 14 / 31 / 14 / 14 ms | 158 / 322 / 164 / 149 ms | 675 / 1,706 / 727 / 735 ms |
| Forget one document | 276 ms | 3,708 ms | 17,202 ms |
| Clear | 206 ms | 2,554 ms | 13,657 ms |
| Peak resident memory of the process | 214 MB | 1,054 MB | 4,333 MB |

## Against the targets in the plan

| Target | Result | Verdict |
| --- | --- | --- |
| S: hybrid p95 ≤ 150 ms | 87 ms | Met |
| M: hybrid p95 ≤ 500 ms | 924 ms | Not met |
| M: exact p95 ≤ 200 ms | 322 ms | Not met |
| M: backfill ≤ 3 s in total | 7.8 s | Not met |
| L: hybrid p95 ≤ 2.5 s | 4.8 s | Not met |
| L: no backfill transaction over 250 ms | 368 ms | Not met |

## What the numbers say

- **The scan by meaning sets the hybrid cost.** Hybrid and semantic latency are close at every size,
  about 7 µs for each chunk. This is the linear scan the brief predicted.
- **Every search pays a fixed cost that grows with the library.** An exact query with no hit takes
  149 ms at 100,000 chunks, though it matches nothing. The likely cause is the check for documents
  with chunks in the active scope (`listScopedDocumentIds`), which joins every chunk with its
  embedding. This is a lead, not a measured cause.
- **The backfill runs once per upgraded index.** At about 78 µs for each chunk, a library of
  100,000 chunks needs about 8 s once. The longest single transaction stays well under the
  5,000 ms busy timeout of other processes, but above the 250 ms target at 500,000 chunks.
- **The triggers make store writes about two and a half to three times slower.** Real indexing time is
  dominated by the embedding model, which this benchmark leaves out, so the share of the triggers in
  real indexing time is smaller. It is **not measured** here.
- **The exact-word index is about one tenth of the store.**
- **Forget and clear grow with the store,** because `VACUUM` rewrites the whole file. The merge adds to
  this, as probe P5 showed.

## An optimization that was tried and reverted

After this run I changed `listScopedDocumentIds` to one `EXISTS` probe for each document, and let the
semantic scan read a vector without a copy when its memory was aligned. All core tests passed. A second
run measured only the 10,000-chunk size before the user stopped all heavy runs. It was slower: hybrid
p95 192 ms instead of 87 ms, and exact p95 with no hit 125 ms instead of 14 ms. I think that SQLite
chose the embedding model index as the outer loop and scanned every embedding once for each document,
but I did not confirm the query plan, and other load on the machine during that run is possible. I
reverted both changes, so the code matches the measurement above. The second run is not repeated.

## Decisions for the user

The plan makes the next step after a failed target a decision for the user:

1. A cheaper active-scope check, measured with its query plan, which addresses the fixed cost.
2. A per-process vector cache for the long-lived app and MCP server, with a local write counter in
   addition to `PRAGMA data_version` (Codex review, finding 14).
3. A vector extension such as `sqlite-vec`, which is a new package and needs approval.
4. Larger or adaptive backfill batches, against the 250 ms transaction target.
