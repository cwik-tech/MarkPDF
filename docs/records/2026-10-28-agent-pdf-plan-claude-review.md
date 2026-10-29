# Review: Agent PDF preparation and retrieval plan

- Reviewed document: `docs/agent-pdf-preparation-plan.md` (untracked, 204 lines)
- Source: working tree at `8eacc44d0d4e8adfa8d66eebec890229b0d4142e`
- Reviewer: Claude (review-only assignment, no second reviewer launched)
- Date: 2026-10-28

## Evidence boundary

I read the plan, the product source, the accepted ADRs and the retrieval skill. I did not modify the plan or any repository file. I did not run tests, the application, a build or a reproduction. I did not open the user's PDF files. All statements below come from static source reading, unless the text says otherwise.

I ran one read-only Code-map summary. The store is in the session scratchpad, outside the repository. Its limits are in the section "Code-map coverage" at the end.

## Verdict

The plan diagnoses the close prompt correctly. Its persistence, bounding and honesty rules are sound. But the plan must not go to implementation in its current form, for four reasons:

1. It reverses two accepted decisions, the consent model and the rejection of a socket, without a plan to supersede them.
2. Its automatic save is a full rewrite of the user's PDF, and the refusal list does not cover digital signatures or encryption.
3. Each save changes the content hash, so the plan's sequence indexes most documents twice.
4. It builds a new transport and a new tool where existing mechanisms already cover most of the journey.

## Findings, ranked by severity

| # | Severity | Finding | Main evidence |
|---|---|---|---|
| F1 | High | MCP `prepare_document` reverses the accepted consent model, and the plan has no superseding ADR or user decision for it | `docs/adr/2026-08-23-MCP-Server-Adapter.md:65-68`, `:206-209`; `docs/adr/2026-08-23-Open-Document-Awareness.md:87-88`; `skills/markpdf-retrieval/SKILL.md:8`, `:37` |
| F2 | High | The automatic save rewrites the whole file with `pdf-lib`. Nothing detects digital signatures or encryption | `src/pdf/document.ts:589`, `:614`, `:730`, `:863-866`; `src/App.tsx:1705-1718` |
| F3 | High | A save changes the content hash, so the plan's sequence reads, recognizes and embeds a document twice | `core/index/indexPdfDocument.ts:99-116`; `src/App.tsx:1421-1452`, `:1768-1774`, `:1785`; `core/store/index.ts:852` |
| F4 | Medium-High | The new socket, tool and command duplicate existing mechanisms. An accepted ADR already rejected a socket | `docs/adr/2026-08-23-Open-Document-Awareness.md:38-42`; `mcp/openDocumentOperations.ts:84-91`, `:203-213`; `electron/main.ts:398-416`; `core/install/cliShim.ts:63-76` |
| F5 | Medium | Existing replies call an incomplete document `indexed`, and the plan fixes only the search reply | `mcp/openDocumentOperations.ts:84-87`; `mcp/operations.ts:314-324`; `src/semanticSource.ts:51-64` |
| F6 | Medium | Capability 1 is not a thin first slice, and the e2e harness cannot reach the forwarding or cold-start path | `electron/main.ts:104-105`, `:402-416`; `AGENTS.md` "Double-loop TDD" |
| F7 | Medium | Same-document concurrency has gaps: no save re-entrancy guard, stale tabs in other windows, and an unmapped thrown index error | `src/App.tsx:1678-1791`; `electron/main.ts` `window:new-for-file`; `core/index/indexDocument.ts:44` |
| F8 | Low-Medium | An atomic replace has macOS side effects that the plan does not name | Plan line 106 |
| F9 | Low | Some line citations have drifted, and two repository documents are already stale | `core/index/indexDocument.ts:32`; `src/App.tsx:826-829`; `AGENTS.md:25` |

## What the plan gets right

These claims match the source:

- **Close-prompt diagnosis.** A generated synthetic outline is the only automatic source of dirty state on open (`src/pdf/document.ts:136-141`, `src/App.tsx:1116`). The other `dirty: true` sites are user-edit handlers (`src/App.tsx:2184-2348`) and the pathless image import (`src/App.tsx:1177-1180`). OCR completion does not mark the tab dirty (`src/App.tsx:978-988`).
- **OCR is not embedded.** `exportPdfBytes` receives no OCR pages (`src/App.tsx:1705-1718`).
- **The write is not atomic.** The `file:write-pdf` handler calls `writeFile` directly (`electron/main.ts:598-604`).
- **Statuses and bounds.** Core distinguishes `ready`, `reused`, `empty`, `incomplete` and `cancelled` (`core/index/indexDocument.ts:32`). MCP enforces a reply bound (`mcp/server.ts:188-199`). `read_pages` reports the unresolved pages in the selection (`mcp/operations.ts:368-380`).
- **Durable rules.** Do not trust an old success marker. Do not clear dirty state without a successful write. Do not autosave user edits. Report a save that succeeded before indexing failed as a partial outcome.

## Finding details and recommendations

### F1. The consent model reverses without a decision (High)

**Evidence.** The accepted MCP ADR says: "Nothing here indexes, grants or deletes. Consent is given out of band, with the command line" (`docs/adr/2026-08-23-MCP-Server-Adapter.md:65-68`). The same ADR rejects an MCP `index` tool, because "Indexing and granting stay on the command line, where a person is present" (`:206-209`). The open-document ADR says that "indexing is still the consent event" (`docs/adr/2026-08-23-Open-Document-Awareness.md:87-88`). The skill repeats both rules (`skills/markpdf-retrieval/SKILL.md:8`, `:37`).

The plan's `prepare_document` lets an MCP client open, index and write a file. The plan proposes an ADR only for the transport (plan lines 97 and 190) and says "do not edit accepted ADRs". It never names the consent reversal.

**Practical effect.** The allowlist is empty by default (`core/consent/allowlist.ts:12`). Under step 1 of the plan, an agent that receives a PDF dragged from Downloads or the Desktop gets `needs_user_action` for each new folder. That breaks the main user journey. A write grant applies to the whole parent directory (`core/consent/allowlist.ts:31-42`), and the same grant also permits `to_markdown` exports into that directory (`mcp/operations.ts:407-415`).

**Recommendations:**

1. Write a superseding ADR for the consent change and the new MCP surface. Do not treat this change as a transport detail.
2. Ask the user which event is the consent for an agent-initiated open, index and save. I recommend a native MarkPDF confirmation for each file, with these choices: "Allow once", "Allow this folder" or "Deny". This keeps a person present at the consent event, as the accepted ADRs require, and it avoids a CLI grant before every drag-and-drop.
3. Keep the read grant and the write grant separate in that dialog.

### F2. The "metadata" save is a full file rewrite (High)

**Evidence.** `exportPdfBytes` loads the file with `ignoreEncryption: true` (`src/pdf/document.ts:589`). It then serializes a new file with `pdfDoc.save()` (`:730`). `pdf-lib` writes a complete new file, not an incremental update. On the way, the function makes these changes:

- It regenerates the appearance of every form field, including fields that nobody changed (`:614`).
- It writes editable-overlay metadata and rewrites MarkPDF annotations (`:626-642`, called with `persistEditable: true` from `src/App.tsx:1712-1713`).
- It splits the existing Keywords entry on spaces and commas and joins it again (`:863-866`). A multi-word keyword such as "machine learning, AI" loses its grouping.

No source file checks for a digital signature (`/ByteRange`, a signature field) or for encryption before the save. A search for those terms finds only the `ignoreEncryption: true` loads.

Plan step 5 refuses "unresolved signature choices". In this codebase that term means MarkPDF's drawn signature overlays (`src/App.tsx:1793-1798`), not cryptographic signatures.

**Risk.** An agent that prepares a digitally signed contract will rewrite it unattended. I expect that rewrite to invalidate the signature, but I did not test it. The result for an encrypted PDF is **unverified**.

The synthetic outline also gives an agent nothing. Agents get their outline from core, which derives it from the extracted Markdown headings (`core/outline/documentOutline.ts:12-25`). The PDF-embedded outline serves only the desktop sidebar and removes the close prompt.

**Recommendations:**

1. Add a narrow exporter that writes only the synthetic-outline Keywords entry. Do not reuse the full edit exporter.
2. Refuse an automatic save for a PDF that has a signature field or `/ByteRange`, is encrypted, or would change more than that entry. Return a typed `needs_user_action` result for each case.
3. Add fixtures for a signed PDF, an encrypted PDF and a form PDF. Assert that an agent preparation leaves each file byte-identical.
4. Put the decision to the user: the user asked to save these changes, and that is achievable. An alternative removes the prompt without rewriting the file: do not count a generated outline as an unsaved user edit, and keep or regenerate it outside the PDF. Record the choice in the ADR.

### F3. Saving changes the hash, and the plan's sequence indexes twice (High)

**Evidence.** The preflight reuse looks up the store by the SHA of the file bytes (`core/index/indexPdfDocument.ts:99-116`). A saved outline changes those bytes, so the store finds no match. The document is then read, recognized and embedded again in full.

The desktop already indexes every open PDF automatically. Semantic search is on by default (`core/ipc/settings.ts:19-20`), and indexing starts 1.2 s after OCR settles (`src/App.tsx:1421-1452`). The generated outline appears only after OCR, during the metadata stage (`src/pdf/openPdfInStages.ts:25-27`). Thus the pre-save index is usually already running when the tab becomes dirty.

After a save, the renderer resets the index state, resets OCR and starts renderer OCR again (`src/App.tsx:1768-1774`, `:1785`). Plan step 7 then calls the indexing service once more.

A document with an unresolved page is never reusable (`core/store/index.ts:852`). Plan line 110 says that reissuing preparation recovers a lost response. For an incomplete document, each reissue repeats all OCR.

**Recommendations:**

1. Change the order for an agent-owned tab: hold the automatic index until the save settles, or until outline extraction reports that no outline was generated. Then index the final bytes once.
2. Do not add a second index call in step 7. Wait for the existing automatic index instead, or replace it for that tab.
3. Do not restart renderer OCR after an agent-owned save when the page content did not change.
4. State the cost of a retry on an incomplete document, and bound the number of retries.
5. Measure one native-text PDF and one mixed PDF before and after this change.

### F4. Avoidable transport and surface (Medium-High)

**Evidence.** The accepted open-document ADR already rejected "a Unix socket or named pipe", because it brings "a server lifecycle, connection handling, framing, timeouts, Windows path differences, and a discovery file anyway" (`docs/adr/2026-08-23-Open-Document-Awareness.md:38-42`). The plan proposes the same socket, but it does not cite this rejection.

The plan also undercounts these existing mechanisms:

- **Completion signal.** `list_open_documents` already reports a content hash and an `indexed` flag for each open tab (`mcp/openDocumentOperations.ts:84-91`).
- **Reading without a grant.** `read_open_document` reads index-first, so it needs no filesystem permission for an indexed document (`mcp/openDocumentOperations.ts:203-213`). Search accepts an open-document reference (`docs/adr/2026-09-05-Open-Document-Semantic-Search.md:22-28`).
- **Executable resolution.** The CLI already runs on the MarkPDF binary itself (`core/install/cliShim.ts:63-76`), and the CLI records `process.execPath` (`cli/main.ts:63`). This answers most of the plan's open question about how to resolve the packaged executable.
- **Request channel.** The single-instance lock already carries file paths to the running instance in `additionalData` (`electron/main.ts:398-416`). A request identifier can travel on the same channel.
- **Result channel.** The per-window session record is already atomic and mode `0600`. It can carry a request identifier and an outcome.

The plan's module list adds eight new files, one CLI command and one MCP tool. Every tool "costs context in every session of every client forever" (`docs/adr/2026-08-23-MCP-Server-Adapter.md:60-63`). The CLI command surface is also a documented contract (`:219-221`).

**Recommendations:**

1. In the transport ADR, evaluate the existing "single-instance request plus session-record result" route against the socket. Cite the earlier rejection.
2. If the plan keeps the socket, explain what new need defeats the earlier reasons.
3. Consider `fs.watch` with a deadline as the wait mechanism. It is event-driven, so it is not the "sleep" that the plan rules out.
4. Keep the new MCP surface to one tool, or extend `list_open_documents`.

### F5. "Indexed" hides incompleteness (Medium)

**Evidence.** `isIndexed` returns true when a store row exists (`mcp/openDocumentOperations.ts:84-87`), and an incomplete document has a row. The search reply has no coverage field (`mcp/operations.ts:314-324`). The plan notices the search gap (plan line 77), but it does not notice the `list_open_documents` gap. In the desktop, an incomplete index shows the "ready" badge with a qualifying message (`src/semanticSource.ts:51-64`). A receipt must not copy that mapping.

**Recommendation.** Add an index status and an unresolved-page count to `list_open_documents` and to `search`. The store already keeps page provenance (`core/store/index.ts:845-852`). This change alone gives an agent the honest fallback signal that the user asked for, without a new tool.

### F6. The TDD sequence is not thin, and the harness has blind spots (Medium)

**Evidence.** Capability 1's outer test needs the transport, a new CLI command, the main-process transaction, the renderer hooks and the safe save before it can go Green. AGENTS.md asks for the first capability to be "a thin working journey through the real stack" ("Double-loop TDD" section).

`MARKPDF_TEST_USER_DATA` turns on test mode (`electron/main.ts:104-105`). In test mode, the app skips the single-instance lock and does not register the `second-instance` handler (`:402-416`). Thus the e2e harness cannot reach the forwarding path or a real cold start in their production form.

On macOS, a Unix socket path has a limit of 104 bytes. Temporary test directories under `/var/folders/...` can come close to that limit. I did not measure this.

**Recommendations:**

1. Make Capability 1 the in-app save journey only: a heading PDF, an agent-owned preparation started through the existing open path, the outline saved, a close without a prompt, and a reopen that keeps the outline.
2. Run a unit Red first for the dirty-reason policy and the narrow exporter.
3. Add the agent transport as Capability 2.
4. Design and document a harness mode for single-instance forwarding before Capability 4.

### F7. Same-document concurrency gaps (Medium)

**Evidence and recommendations:**

- `saveTab` has no in-flight guard (`src/App.tsx:1678-1791`). A user's Cmd+S and an agent save can interleave on the same tab. The plan's "revision" check needs a counter that does not exist yet. Name it, and serialize saves for each tab in the renderer as well as in the main process.
- The same file can be open in several windows (`window:new-for-file`). After a successful save in one window, the other tabs keep stale bytes. A later save from one of those tabs silently removes the outline. Define what happens to those tabs: refuse the save, reload the tab, or mark it as conflicted.
- A concurrent rebuild throws `ConcurrentIndexError` instead of returning a status (`core/index/indexDocument.ts:44`). The receipt needs a typed, retryable mapping for it.

### F8. Side effects of an atomic replace on macOS (Low-Medium)

A temporary file followed by a rename creates a new inode. That change can drop extended attributes (Finder tags, quarantine), ACLs and hard links. It can also confuse iCloud Drive or Dropbox sync. The plan mentions file permissions only (plan line 106). Decide which attributes the save must keep, and test them. This finding is a lead, not a measured defect.

### F9. Citation drift and stale documents (Low)

- `IndexStatus` is at `core/index/indexDocument.ts:32`, not `:26`.
- The `exportPdfBytes` call starts at `src/App.tsx:1705`, not `:1703`.
- A renderer comment says that the window contributes its OCR to indexing (`src/App.tsx:826-829`). The main process does its own OCR (`electron/semantic.ts:198-204`).
- AGENTS.md says that MCP has "four tools" (`AGENTS.md:25`), but there are six runners (`mcp/server.ts:32-39`).

Add the last three items to the plan's documentation audit.

## Decisions for the user

1. **Consent event (F1).** Choose one: a native MarkPDF confirmation for each file (recommended), an existing CLI grant, or no consent check for an agent-initiated open.
2. **Save semantics (F2).** Choose one: a narrow in-file save with refusals for signed, encrypted or form files (this matches the request literally), or no dirty state for a generated outline and no file rewrite.
3. **Transport (F4).** Choose one: the existing single-instance request with a session-record result, or a new socket that supersedes the accepted ADR.

## Explicit unknowns

- I did not reproduce the close prompt with the user's PDF, and I did not open any user PDF. The diagnosis is source-backed only.
- I did not test how `pdf-lib` handles an encrypted PDF that is saved with `ignoreEncryption: true`.
- I did not test whether the rewrite invalidates a digital signature. I expect that it does.
- I did not measure the cost of the double indexing.
- I did not measure the socket path length in test directories.
- I did not compare a launch through `process.execPath` with a launch through `open -a` on macOS.
- I did not inspect the skill discovery formats of agent clients. The plan has the same gap.

## Code-map coverage

I ran `code-map inspect --worktree --summary`. The analysis ID is `A-9b565737f7fde00a`, and its store is in the session scratchpad.

- 107 code files are outside the configured source roots and are not mapped: `core` (72), `cli` (24), `mcp` (9) and `scripts` (2). Code-map thus has no import, finding or test evidence for most of the layers that this plan changes.
- It reports 77 unresolved relative imports. I think that most of them are `electron/` imports of build output in `dist-core/`. I did not confirm this.
- No architecture rules are declared, no coverage report exists, and no tests ran.
- It reports `sandbox: false` for the main window (`electron/main.ts:323`). A new external control path raises the importance of strict validation at the renderer boundary.

I used Code-map only for these coverage facts. All findings above come from direct source reading. I did not change the Code-map configuration.
