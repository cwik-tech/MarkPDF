# The MCP server can see what MarkPDF has open

## Status

Accepted. Supersedes the "Exactly four tools, and nothing else" decision in
`2026-08-23-MCP-Server-Adapter.md`, which now reads six.

## Context

Every tool the server offered required the caller to already know a path or a content hash. That
is the wrong shape for the most common request a person actually makes of an assistant while
reading something: *"summarise the PDF I have open."* The assistant has no way to find out which
one that is, and asking the person for a path defeats the point of asking the assistant at all.

The obstacle is that the two halves of MarkPDF cannot see each other. Tab state lives entirely in
React state in the renderer (`src/App.tsx:434-435`), with no persistence and no bridge exposing it.
The MCP server is a separate process, launched by the client, which resolves its data directory
from the environment (`mcp/main.ts:33`) and shares exactly two things with the application: the
SQLite index and the consent record (`core/paths.ts:41-54`). There is no socket, no shared memory,
and no IPC between them.

## Decision

### One JSON snapshot file per window, written by the main process

`<dataDir>/session/open-documents/<pid>-<windowId>.json`, mode `0600`, written into a `mkdtemp`
sibling and renamed onto the target. That is the arrangement the consent record already uses
(`core/consent/allowlistFile.ts:215-235`) and it is chosen for the same reasons: a reader never
sees a half-written file, and an interrupted write leaves the previous one intact.

**One file per window rather than one file with a lock.** The consent record's lock *fails closed*:
contention refuses the write and tells the caller to try again
(`core/consent/allowlistFile.ts:337-355`). That is correct for a grant, which must never be undone
by accident, and wrong for something that changes when a person clicks a tab — two windows updating
at once would silently drop a tab change. Giving each window sole ownership of one file removes the
contention rather than arbitrating it: there is no lost update to prevent, so there is no lock.

Rejected alternatives:

- **A Unix socket or named pipe.** Live and precise, and it brings a server lifecycle, connection
  handling, framing, timeouts, Windows path differences, and a discovery file anyway — all of it
  failure surface for a payload of a few hundred bytes of metadata.
- **A table in the existing SQLite index.** It needs a migration past schema 2
  (`core/store/schema.ts:6`), it puts per-second volatile state in the durable store, and
  `better-sqlite3` is synchronous, so a write on every tab switch blocks the main process. It would
  also mean clearing the index silently cleared what is open.

### The snapshot carries names, never text, and its paths never leave the process

The record holds a tab identity, kind, name, page count, content hash and an unsaved flag. It holds
a `path` **only** so that read permission can be proved for a document that is not yet indexed, and
that path is stripped from every tool reply, refusals included. A caller reaching for these tools is
by definition one that does not know where anything is; answering with a path would hand over
exactly what it was spared from asking for, and for every open document rather than the one being
read. `explainOpen` in `mcp/openDocumentOperations.ts` therefore names the *action* — index it, or
grant its folder — rather than the folder.

**A thrown error is the hard case, and it is guarded separately.** Node puts the path into the
message of almost every filesystem error, and the call boundary answers an exception with that
message verbatim (`mcp/server.ts:114-116`). That is right for the four tools that take a path,
because the caller supplied it, and wrong here — a document moved after the snapshot was written
would disclose, inside a failure, the one thing these tools promise never to return. So both
operations catch around the calls that reach outside this process and answer with a sentence
carrying the document's *name* and the error's *code* — a short constant matched against
`/^[A-Z][A-Z0-9_]{1,31}$/` — and never its message. The code is the useful half anyway: `ENOENT`
is exactly what a moved document produces. Each catch is drawn around those calls alone, so a
fault in the bounding that follows is still reported as itself.

No document text passes through the snapshot. Text leaves this program through the bounds in
`core/output/budget.ts` and nowhere else; a second copy living in a metadata file would be neither
bounded nor counted.

### Page position is deliberately not reported

`projectOpenDocuments` reads `currentPage` and drops it. It is the most volatile thing about a tab
and of no use outside the window, and carrying it would mean writing a file on every scroll. The
renderer publishes only when the projected report actually changes, so page turns, OCR progress
ticks and search state produce no write at all.

### Having a document open is a name, not an authority

This is the security decision. The snapshot is written by another process, so if open-ness granted
read access, anything able to write that file — same-user malware, or a compromised renderer —
would gain arbitrary file reads through this server by claiming `~/.ssh/id_rsa` was open. So
`read_open_document` hands the identity to the same `resolveDocumentPages` every other tool uses
(`core/documents/documentPages.ts:68`), and the allowlist decides exactly as it would for a path a
caller typed. Layer 3 of the plan's consent model is untouched: **indexing is still the consent
event.**

The access class is `index-first`. A document the application has already indexed — which, with
semantic search on by default (`core/ipc/settings.ts:19-25`) and open PDFs auto-indexing
(`src/App.tsx:1318-1348`), is nearly all of them — is read with no filesystem permission at all.
Anything else needs the grant.

### Focus is stamped by the main process, and creating a window counts as focusing it

No window can know whether it is the one a person is looking at, so a renderer deciding its own
focus would leave two windows each certain they were active. The main process keeps an increasing
counter and stamps it on `browser-window-focus`.

It also stamps it when a window is created, because MarkPDF shows and focuses every window it
opens. This was added after measuring: a probe run of the Electron journey recorded **zero**
`browser-window-focus` events and `isFocused()` false after calling `focus()`, because a
Playwright-launched application is never the frontmost one. Without creation counting as focus,
every window sat at order `0` and the answer to "which document is open" fell to an unstated
tie-break on window identifier rather than to anything meaning focus.

### A window whose process is gone is not open

A clean quit removes its own files (`app.on("will-quit")`), a closing window removes its own, and a
reload empties its own — so anything a reader later finds is the residue of a crash. Rather than
believing it, the owning process is checked with `process.kill(pid, 0)` and a dead one's file is
ignored and cleared away.

Deciding it is gone and clearing it away are separate, and only the first is load-bearing. A data
directory somebody has locked down, or one owned by another account, can refuse the removal — and a
listing that threw because a tidy-up was refused would take every live window down with it. So the
removal is guarded on its own, narrowly enough that a directory which cannot be listed or a file
which cannot be parsed is still reported rather than swallowed.

`core/session/processLiveness.ts` is a **new, separate** helper rather than a refactor of the
identical logic inside `core/consent/allowlistFile.ts:255-271`. That one is a security boundary
whose only job is to choose an error message; coupling an advisory session check to it would mean a
change made for one could quietly alter the other. The doubt points one way here: only a definite
`ESRCH` counts as gone, because a live window wrongly called dead loses a person the documents they
have open, while a dead one wrongly called live shows a stale name — and a stale name grants
nothing, per the decision above.

There is **no wall-clock staleness rule**, for the reason already recorded against the consent
lock: a cutoff takes state away from a process that was merely paused at a breakpoint.

### The active document comes first in the listing

Both replies are bounded by `fitReply` like every other. The listing carries no document text, so
what can make it large is many tabs with long names — and a bound cuts from the end. Putting the
active document first makes truncation a *shorter* answer rather than a *wrong* one.

### Markdown tabs are listed, and refused

A Markdown tab has no index entry and cannot be read by an extractor built for PDFs
(`src/App.tsx:764`). Leaving it out of the listing would mean a person looking at their notes,
asking about "the document I have open", is answered about a different file entirely. So it is
listed with its kind, and `read_open_document` refuses it by name rather than falling through to
whichever PDF sits behind it.

### `ref` defaults to the published literal `"active"`

A tool argument here is a string or a number and never a flag (`mcp/arguments.ts:4`), so
`use_active: true` would mean widening the validator every tool depends on. A published `default`
is better than either: the schema states what absence means, so reading the PDF a person has open
is a call with no arguments, and an agent can still name `"active"` deliberately. A real reference
is `<pid>-<windowId>:<tabId>` and cannot collide with it.

## Consequences

- An assistant can act on "the document I have open" with no path, and the reply discloses no path.
- Two more tools cost context in every session forever. They were taken because none of the
  existing four can answer this question at all — each requires the caller to already know the
  answer.
- `ToolContext` gains `openDocuments()`, read per call like the consent record.
- Some unsaved work is visible to a reader and some is not, and the tool description says which.
  MarkPDF indexes the bytes it has loaded, so an unsaved page deletion is picked up once the tab
  reindexes (`src/App.tsx:2137-2168` sets `dirty: true` **and** resets the index status). Overlays —
  comments, highlights, signatures, form entries — are not part of those bytes until they are
  serialized at save (`src/App.tsx:1556-1569`), so they stay invisible. `unsavedChanges` is reported
  so an answer can be qualified either way.
- The channel is portable — `node:fs` and `process.kill(pid, 0)` only — but is exercised on macOS
  alone. **Unverified on Windows and Linux.**

## Verification

- `tests/e2e/open-documents-mcp.spec.ts` — three Electron journeys, each driving the official SDK
  client over a real stdio transport against the real server, with the real application running:
  reads the active document with no arguments and discloses no path; follows focus across two
  windows; and shows nothing after the application is killed with `SIGKILL`. The last is a forced
  crash on purpose — a clean quit deletes its own record and would prove nothing about the liveness
  check. The one seam replaced is the operating system's window server, for the measured reason
  recorded above.
- `core/session/openDocuments.test.ts` — the file format against real temporary directories: mode
  `0600`, atomic replacement, two windows merging without overwriting, focus order deciding the
  active document *when it disagrees with the order the files are listed in*, active-first
  ordering, a reaped process identifier being ignored and cleared, and a damaged file being skipped
  and counted rather than taking its neighbours down. Clearing a dead window's file away is a
  courtesy rather than the answer, so a directory whose permissions refuse the removal still lists
  the windows that are open — proved by making the containing directory read-only, a failure the
  superuser is exempt from and which that test therefore skips for that documented reason.
- `core/session/processLiveness.test.ts` — including a genuinely reaped child process.
- `core/session/openDocumentsRequest.test.ts` — the renderer's report as untrusted input: control
  characters, oversized names and paths, bad page counts and hashes, duplicate tab identities, and
  an active tab that was not listed.
- `src/openDocuments.test.ts` — the projection carries no text or bytes, reports Markdown tabs, and
  **produces an identical report after a page turn**.
- `mcp/openDocumentOperations.test.ts` — no path in any reply; an indexed document read with the
  filesystem untouched; an unindexed, ungranted document refused without naming where it is; an
  active Markdown tab refused rather than substituted. Three of these cover the *failure* paths,
  using a genuine Node `ENOENT` rather than a hand-written error: a read that throws, and a record
  that cannot be read, each answered without the path or the data directory in the sentence.
- `mcp/server.test.ts` — the same promise at the public call boundary, which would otherwise answer
  a thrown error with its message verbatim.
- `mcp/server.test.ts` — five hundred open tabs with long names still fit the reply budget, report
  what was omitted, and still lead with the active document.
- `mcp/toolSchemas.test.ts`, `mcp/journeys/toolSession.test.ts` — six tools, the published
  `"active"` default, and no document-identity arguments on the open-document tools.

Seven mutations were applied and each turned the intended test red: removing the liveness check,
ignoring focus order, sorting the listing by name, adding `path` to the public view, falling back
to a PDF behind an active Markdown tab, and reading the snapshot's path without the consent model.
The second of those exposed a fixture that had been passing for the wrong reason; it was corrected
before the mutation was reverted. The seventh put the error *message* where the error *code* goes,
and turned all four path-privacy failure tests red.
