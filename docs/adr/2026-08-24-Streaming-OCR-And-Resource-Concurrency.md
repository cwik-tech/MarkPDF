# Streaming OCR and resource-specific concurrency

## Status

Accepted.

## Context

OCR previously rasterised every requested page into PNG bytes before recognition began. A long
scan therefore retained every page image at once. MCP also used one general four-call scheduler,
so several accepted conversions could each hold a rasterisation and recognition engine while a
cheap index-only search waited behind unrelated document work. A queued call observed cancellation
only after it eventually acquired a permit.

## Decision

`rasterisePdfPagesStreaming` is an async iterable. It opens or borrows one pdf.js document, renders
one selected page, yields that image, and cleans the page before rendering the next. The existing
`rasterisePdfPages` API remains as a collector for callers that intentionally need an array. OCR
consumes the iterable directly and creates the recogniser lazily after the first image arrives.

`BoundedScheduler.run` accepts an optional `AbortSignal`. A queued waiter registers one abort
listener, removes itself from the FIFO queue when cancelled, and rejects with
`SchedulerCancelled`; starting the waiter removes the listener. Active work still owns its permit
until it returns, and its own boundary receives the same signal.

MCP retains the four-permit tool scheduler for general calls and adds a one-permit OCR scheduler
inside the OCR resolver. Search never acquires the OCR permit, so it can run while recognition is
in progress. Cancellation while waiting for OCR is translated to the OCR pipeline's existing empty
result plus aborted signal outcome.

## Consequences

- A scan retains one rendered page image at a time instead of an array proportional to page count.
- Concurrent MCP requests cannot start more than one OCR engine, while cheap index work remains
  independently scheduled.
- A cancelled queued operation gives up its place immediately without polling or later work.
- The array-returning rasteriser remains available, but callers choosing it still accept its memory
  cost explicitly.

## Alternatives considered

- A smaller limit on the single tool scheduler was rejected because it would make search wait for
  an unrelated scan.
- Polling queued signals was rejected because `AbortSignal` already provides the event that changes
  the queue state.
- Parallel OCR was rejected because it multiplies page-image and engine memory without improving
  the single-process resource bound this change establishes.

## Verification

- Per-page production order: `core/ocr/ocrStreaming.test.ts`.
- Abortable FIFO queueing: `core/index/concurrency.test.ts`.
- Separate tool and one-permit OCR schedulers: `mcp/context.test.ts`.
- Sixty-page RSS check, opt-in: `core/ocr/ocrMemory.live.test.ts`.
- Mutation proof: raising the OCR limit from one to four fails the concurrency assertion in
  `mcp/context.test.ts`; the limit was restored and the test rerun green.
