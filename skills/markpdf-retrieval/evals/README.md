# MarkPDF retrieval benchmark

## Summary

This experiment tested two separate questions on the same two PDFs:

1. Can MarkPDF MCP retrieve enough evidence to answer accurately while sending
 less document material to Claude than native whole-PDF reading?
2. Does the `markpdf-retrieval` skill make MarkPDF MCP usage more efficient than
 letting the same agent choose its own MarkPDF route?

The answer to both questions was yes, with qualifications.

- On the short technical report, MarkPDF cut document payload by 96.8%, fresh
input by 84.1%, raw token events by 60.3%, and cost by 79.1% compared with native
PDF ingestion. Both answers were accurate. MarkPDF took 9.1% longer.
- Claude could not ingest the long reference book natively because the source
exceeded the API's 600-page limit. MarkPDF answered it accurately from a small
retrieved excerpt. This is a feasibility result, not a valid answer-to-answer
efficiency comparison.
- On the short technical report, the retrieval skill cut MarkPDF's serialized
tool payload by 61.8% and cost by 29.6%. Wall time fell by 18.5%. Raw token
events rose by 10.5% because the second run read more cached prompt tokens.
- On the long reference book, the retrieval skill cut MarkPDF's serialized tool
payload by 81.3%, fresh input by 51.5%, raw token events by 39.5%, and cost by
39.2%. Wall time rose by 8.6%.

The skill consistently removed unnecessary outline and search calls. Its main
failure was output discipline. Its provenance instruction caused extra text
after an exact 100-word answer. The tests did not compare MCP with the MarkPDF
CLI, so they do not measure MCP protocol overhead against CLI overhead.

## Anonymized source profiles and tasks

The source identities are deliberately omitted. This document does not include
filenames, titles, authors, publishers, hashes, exact page counts, quotations,
section names, or source page references.

### Short technical report

- General subject: methods for developing, testing, and evaluating AI systems.
- Size class: fewer than 100 pages.
- Task: summarize the conclusion of one evaluation-related section in exactly
100 words.

### Long professional reference book

- General subject: managing information and data across large organizations.
- Size class: more than 600 pages.
- Task: compare several approaches described in a small cluster of pages. The
answer had to cover how each approach works, its main advantage and limitation,
and the organizational conditions attached to the choices, all in exactly 100
words.

## Methodology

### Test design

The experiment used fresh Claude Code sessions with `claude-opus-5`. Every valid
arm invoked `unslop`. Sessions in each pair received the same document question.
They ran with read-only permissions and did not use web search.

The work was split into two paired comparisons:


| Comparison                    | Baseline arm                                                 | Treatment arm                                                  |
| ----------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| Native PDF vs MarkPDF         | Native `Read`, empty MCP configuration, MarkPDF skill hidden | MarkPDF MCP only, no native `Read`, `markpdf-retrieval` loaded |
| MarkPDF without vs with skill | MarkPDF MCP, no retrieval skill                              | Same MarkPDF MCP tools plus `markpdf-retrieval`                |


The native controls could not call MarkPDF. Their MCP configuration was
explicitly empty. The MarkPDF treatment arms could not use Claude's built-in
`Read` tool. This prevented quiet fallback between routes.

The MarkPDF-without-skill arms are called "unguided" below. They still had
access to the MCP tool names and schemas. The skilled arms added routing
instructions that favor one semantic search followed by a bounded page read.

### Metrics

- Document or MCP payload is the serialized byte count returned by the document
tool calls. Native and MCP payloads use different envelopes, but both measure
how much document material entered the agent trace.
- Fresh input is uncached input plus cache-creation input.
- Raw token events are input, cache creation, cache reads, and output summed
across turns. They are not unique context tokens and are not all billed at the
same rate.
- Thinking tokens are a subset of output tokens in these traces.
- Percentage change is `(treatment - baseline) / baseline`. A negative value
means the treatment used less.
- Cost and duration include the complete agent run, not only document retrieval.
- Answer quality was checked against the source passage. Exact word-count
compliance was assessed over the complete response, including provenance
notes.

### Controls and limitations

- Each result is one run, not a repeated sample. It demonstrates behavior but
does not establish a stable mean or variance.
- Some paired sessions overlapped in time. Timing can include local contention.
- Prompt-cache warmth differed between sequential runs. Cost and raw-token
comparisons therefore need the fresh-input and cache-read breakdown.
- The native long-book arm failed before answering. Its cost and duration describe
a failed attempt and cannot serve as a successful efficiency baseline.
- The experiment did not run the MarkPDF CLI. No conclusion about CLI versus MCP
token overhead follows from these results.

## Results

### Native PDF vs MarkPDF MCP on the short technical report


| Metric                   | Native whole PDF | MarkPDF MCP with skill | Change with MarkPDF |
| ------------------------ | ----------------: | ----------------------: | -------------------: |
| Result                   | Accurate         | Accurate               | Both succeeded      |
| Document payload         | 792,428 bytes    | 25,461 bytes           | **96.8% lower**     |
| Fresh input tokens       | 199,250          | 31,670                 | **84.1% lower**     |
| Raw token events         | 257,636          | 102,195                | **60.3% lower**     |
| Cost                     | $2.0913          | $0.4368                | **79.1% lower**     |
| Duration                 | 37.5 s           | 41.0 s                 | **9.1% higher**     |
| Agent turns              | 5                | 7                      | 2 more              |
| Complete response length | 100 words        | 156 words              | Native complied     |


The native arm ingested the complete PDF in a 792,428-byte `Read` result.
MarkPDF performed one semantic search and read a small cluster of relevant
pages. Its answer body contained exactly 100 words, but a 56-word source and
scope note broke the total-length requirement.

### Native PDF vs MarkPDF MCP on the long reference book


| Metric                   | Native whole PDF           | MarkPDF MCP with skill | Observed difference        |
| ------------------------ | --------------------------: | ----------------------: | --------------------------: |
| Result                   | Failed                     | Accurate answer        | Only MarkPDF completed     |
| Document transfer        | 14,998,935 bytes, rejected | 18,094 bytes, accepted | **99.9% lower**            |
| Fresh input tokens       | 17,842                     | 25,182                 | 41.1% higher               |
| Raw token events         | 56,331                     | 97,140                 | 72.4% higher               |
| Cost                     | $0.2122                    | $0.4073                | 92.0% higher               |
| Duration                 | 13.8 s to fail             | 55.0 s to answer       | 299.4% higher              |
| Agent turns              | 4                          | 7                      | 3 more                     |
| Complete response length | No answer                  | 120 words              | MarkPDF body was 100 words |


The native tool produced a 14,998,935-byte result, but the model API rejected it
with `A maximum of 600 PDF pages may be provided.` The document was removed from
context and the agent refused to answer. MarkPDF searched its index, read a
small cluster of relevant pages, and completed the task.

The percentage changes in this table are trace differences, not efficiency
wins or losses. The native arm stopped at an error while the MarkPDF arm did the
full work of answering. The only directly useful comparison is feasibility and
the 99.9% reduction in document transfer.

An earlier native attempt also failed after trying page-range reads because the
local Poppler renderer was unavailable. It cost $0.2675 and took 25.7 seconds.
The whole-file retry above exposed the independent 600-page API limit and is the
native result used in the table.

### MarkPDF MCP without vs with the skill on the short technical report


| Metric                            | Unguided MarkPDF            | MarkPDF with skill | Change with skill |
| --------------------------------- | ---------------------------: | ------------------: | -----------------: |
| Route                             | List, outline, search, read | List, search, read | Outline removed   |
| Search results requested          | 10                          | 3                  | **70.0% lower**   |
| PDF pages read                    | 6                           | 2                  | **66.7% lower**   |
| MCP calls                         | 4                           | 3                  | **25.0% lower**   |
| Serialized MCP payload            | 31,737 bytes                | 12,109 bytes       | **61.8% lower**   |
| Cache-created input tokens        | 36,539                      | 21,928             | **40.0% lower**   |
| Cache-read input tokens           | 64,802                      | 91,276             | 40.9% higher      |
| Output tokens, including thinking | 4,619                       | 3,851              | **16.6% lower**   |
| Thinking tokens                   | 3,918                       | 2,978              | **24.0% lower**   |
| Raw token events                  | 105,968                     | 117,065            | 10.5% higher      |
| Cost                              | $0.5133                     | $0.3612            | **29.6% lower**   |
| Duration                          | 52.1 s                      | 42.5 s             | **18.5% lower**   |
| Agent turns                       | 7                           | 8                  | 1 more            |
| Complete response length          | 100 words                   | 168 words          | Unguided complied |


Both answers captured the section's main conclusion. The skill retrieved much
less material and reduced uncached input, reasoning output, cost, and time. Raw
token events increased because the skilled run read 40.9% more cached input.
Cache reads cost less than fresh input, which is why cost still fell by 29.6%.

### MarkPDF MCP without vs with the skill on the long reference book


| Metric                   | Unguided MarkPDF          | MarkPDF with skill | Change with skill              |
| ------------------------ | -------------------------: | ------------------: | ------------------------------: |
| Route                    | Outline, 2 searches, read | 1 search, read     | Outline and one search removed |
| MCP calls                | 4                         | 2                  | **50.0% lower**                |
| Search results requested | 20                        | 5                  | **75.0% lower**                |
| PDF pages read           | 4                         | 4                  | No change                      |
| Serialized MCP payload   | 80,448 bytes              | 15,004 bytes       | **81.3% lower**                |
| Fresh input tokens       | 44,089                    | 21,368             | **51.5% lower**                |
| Cache-read input tokens  | 110,229                   | 69,804             | **36.7% lower**                |
| Raw token events         | 158,295                   | 95,704             | **39.5% lower**                |
| Output tokens            | 3,977                     | 4,532              | 14.0% higher                   |
| Thinking tokens          | 2,957                     | 3,731              | 26.2% higher                   |
| Cost                     | $0.5954                   | $0.3618            | **39.2% lower**                |
| Duration                 | 46.7 s                    | 50.7 s             | 8.6% higher                    |
| Agent turns              | 7                         | 7                  | No change                      |
| Complete response length | 117 words                 | 162 words          | Both exceeded 100              |


Both runs read the same four evidence pages and produced factually accurate
answers. The 53,700-byte outline dominated the unguided payload. The skill
removed it and cut total MCP payload by 81.3%. The skilled run cost less but took
four seconds longer because it generated more output and thinking tokens. The
trace shows the token difference but does not prove why the model reasoned
longer.

The unguided answer placed more of the requested organizational conditions
inside its 100-word body. The skilled answer moved two conditions into a
62-word postscript. Both violated the total-length constraint.

## Conclusions

Every completed answer was factually accurate. Across the three successful
answer-to-answer comparisons, MarkPDF reduced cost by **29.6% to 79.1%** and
reduced serialized document payload by **61.8% to 96.8%**. The long native run
did not answer at all because the document exceeded the API's 600-page limit.
MarkPDF completed that task after reducing document transfer by **99.9%**.

The individual results were:

| Category | Short report | Long book | Trend |
|---|---|---|---|
| Accuracy | Both answers were accurate | Native ingestion failed; MarkPDF produced an accurate answer | Native ingestion lost feasibility beyond the API limit; MarkPDF remained accurate |
| Document transfer | **96.8% lower** | **99.9% lower**; the native document was rejected | Reduction increased by **3.1 percentage points**, with a failed long baseline |
| Input tokens | Fresh input **84.1% lower** | Not comparable because native ingestion failed | No valid native trend because the long baseline failed |
| Raw token events | **60.3% lower** | Not comparable because native ingestion failed | No valid native trend because the long baseline failed |
| Cost | **79.1% lower** | Not comparable because the native cost covered only a failed attempt | No valid native trend because the long baseline failed |
| Wall time | **9.1% higher** | Not comparable because the native run stopped at the API limit | No valid native trend because the long baseline failed |
| Response length | Native: 100 words; MarkPDF: 156 words | Native: no answer; MarkPDF: 120 words | No like-for-like native trend; MarkPDF's overrun shrank from 56 to 20 words |
| Skill accuracy | Unguided and skilled answers were accurate | Unguided and skilled answers were accurate | Accuracy remained stable as source size and question complexity increased |
| Skill retrieval work | MCP calls **25.0% lower**, search results requested **70.0% lower**, pages read **66.7% lower** | MCP calls **50.0% lower**, search results requested **75.0% lower**, same evidence pages read | Call and search-result reductions grew; the page-read reduction disappeared |
| Skill MCP payload | **61.8% lower** | **81.3% lower** | Payload saving grew by **19.5 percentage points** |
| Skill input tokens | Cache-created input **40.0% lower**; cache-read input **40.9% higher** | Fresh input **51.5% lower**; cache-read input **36.7% lower** | Mixed cache behavior became broad input-token reductions |
| Skill raw token events | **10.5% higher** because the run reused more cached prompt input | **39.5% lower** | Changed from an increase to a reduction, a **50.0-point swing** |
| Skill output tokens | **16.6% lower**, including thinking | **14.0% higher** | Reversed from lower to higher output |
| Skill thinking tokens | **24.0% lower** | **26.2% higher** | Reversed from lower to higher thinking, a **50.2-point swing** |
| Skill cost | **29.6% lower** | **39.2% lower** | Cost saving grew by **9.6 percentage points** |
| Skill wall time | **18.5% lower** | **8.6% higher** | Reversed from faster to slower |
| Skill response length | Unguided: 100 words; skilled: 168 words | Unguided: 117 words; skilled: 162 words | Skilled overrun shrank from 68 to 62 words; unguided overrun grew from 0 to 17 words |

The trend column compares only these two runs. It does not establish how the
metrics will scale across other documents.

The processing benefit came from narrower retrieval. The skill removed broad
outlines and one unnecessary search on the long source, requested fewer search
hits, and kept page reads focused. Less retrieved text usually meant fewer input
tokens and lower cost. The short skill comparison is the exception in raw token
events because it reused more cached prompt input.

Payload reduction is the strongest result because it follows directly from the
serialized tool output. Token, cost, and timing results come from single runs
and need repeated, cache-balanced trials before they can support a stable
average-performance claim.

Accuracy was preserved, but output compliance still needs work. The skill's
provenance instruction caused text after the requested 100-word answer.
Provenance must fit inside a hard output limit or be omitted unless requested.
