# Agent PDF plan review disposition

Date: 2026-10-28. Reviewer: Claude, launched through Orca in the MarkPDF workspace; integrator: Codex. Scope: source-backed review and plan revision only. The [original Claude report](2026-10-28-agent-pdf-plan-claude-review.md) is retained verbatim, including claims corrected below. The [revised plan](../agent-pdf-preparation-plan.md) is the implementation proposal; its Status section owns verification status.

Original plan SHA-256: `e553b8b7816ecc8d2de610df817f2b1974261ee11f72d7ed4853eea52886d6da`. Review terminal: `term_6742aa11-0664-4546-870f-650510dd2c36`. Request: `9b3755b5-1532-4e1a-8b7e-98c692fdf72c`.

## Disposition of all findings

| Finding | Decision | Reason and plan change |
| --- | --- | --- |
| F1: accepted MCP/consent policy | Accepted policy gap; deferred new consent UI | Require a superseding ADR for MCP preparation, not just transport. Preserve existing out-of-band read/write grants, require write only when a save is needed, document first-use setup. The user has authorized planning automatic save; no need to ask the same high-level question again. Per-file allow-once grants are a separate scope extension. |
| F2: general exporter rewrites the PDF | Accepted, with limits explicit | Propose a narrow semantic outline exporter preserving unrelated keywords and annotations. It still rewrites bytes, so do not call it incremental or byte-preserving. Refuse automatic writes to encrypted, signature-bearing or form PDFs initially; test originals remain unchanged. Do not choose the alternative of hiding the dirty state because the user specifically requested saving. |
| F3: repeated extraction/indexing | Accepted scheduling risk; qualified frequency | Suppress automatic scheduling before an agent-owned open, use one final-byte index job, avoid unconditional renderer OCR restart, and make incomplete retry costs explicit. The source permits duplicate work; neither reviewer measured how often it occurs, so reject the categorical claim that most documents are necessarily indexed twice. |
| F4: transport and surface complexity | Accepted simpler transport; retained one preparation tool | Prefer existing single-instance forwarding plus event-driven private result records. Validate cold/warm lifecycle, cancellation and watcher races before implementation. Keep one new preparation tool: passive listing cannot command or acknowledge a save. Claude's statement that the public listing returns a hash is incorrect: `mcp/openDocumentOperations.ts:59` returns ref/metadata, not contentHash. Its indexed flag proves only row existence (`:85`), not completed preparation. |
| F5: incomplete state hidden by indexed flag | Accepted | Add explicit state and unresolved-page count to listing and search; retain existing boolean for compatibility. Unknown provenance remains unknown. Preserve selected-page warnings from read_pages. |
| F6: first test too broad; lifecycle harness gap | Accepted | Start with focused policy/exporter Red tests and a desktop save journey, then external CLI/MCP preparation. Add a production-equivalent isolated lifecycle harness because test mode bypasses forwarding. Do not create a test-only product API. |
| F7: save/concurrency ownership | Accepted | Explicit documentRevision and per-tab save owner, shared save coordinator, initial refusal for multiple open copies, typed ConcurrentIndexError mapping. Return busy rather than introduce multi-subscriber coalescing. |
| F8: filesystem metadata preservation | Accepted as unverified risk | Define permissions, xattrs and ACL preservation; refuse unsupported metadata/hard-link cases. Explicitly verify cloud-sync behavior rather than claiming atomic replacement preserves everything. |
| F9: citations and stale documents | Accepted | Correct cited locations and include stale four-tool wording and renderer OCR comment in the implementation documentation impact. No unrelated policy/source edits in this planning task. |

## Additional integrator corrections

- Respect the disabled semantic-indexing setting; return a clear remedy instead of silently enabling it (`src/App.tsx:800`, `core/ipc/settings.ts:19`).
- Snapshot model/profile for each preparation and expose them in its receipt. A later settings change must not make the old scope appear current.
- Remove ELECTRON_RUN_AS_NODE when launching the desktop from the CLI; account for development entry points separately from packaged process.execPath (`core/install/cliShim.ts:63`, `cli/main.ts:63`).
- Defer the generalized multi-client installer and duplicate-request coalescing. Manual setup and typed busy responses are sufficient for the first capability.

## Remaining gates

This review did not resolve the actual startup/result/cancellation protocol or prove PDF/file-metadata preservation. The plan names those as prerequisites with concrete verification. No product implementation is authorized by this review record. No application correctness, runtime performance or agent-compliance claim is established by static review.

## Integration ordering clarification

The desktop capability keeps the repository-required outer acceptance Red before cross-layer implementation, followed by focused inner loops; Claude's unit-first suggestion does not override that rule. The isolated production-equivalent lifecycle harness is a prerequisite of Capability 2, before cold/warm transport tests, rather than deferred until recovery work.
