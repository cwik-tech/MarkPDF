# 2026-10-31 An agent shows its evidence in the window

## Status

Accepted on 2026-10-31 under the user's instruction to implement the reviewed plan
`docs/agent-evidence-and-comments-plan.md`. Extends
`docs/adr/2026-10-28-Agent-PDF-Preparation.md` and leaves its preparation channel unchanged.

## Context

An agent cites "page 12", and the person must then find the passage. The running app could already
take one kind of agent request, preparation, through its single-instance handler
(`electron/main.ts`). That channel had limits that matter more for a request that changes what the
window shows: two separate filesystem calls to read a request, a predictable temporary result name,
an unbounded result read, and no rule against a replayed request. An independent review (Codex,
finding R4) named them.

A citation is more useful when the person can click it. No URL scheme existed. A `markpdf://`
address can come from any application, so the operating system delivers it from a web page or an
email as readily as from an agent's answer.

## Options considered

| Option | For | Against |
| --- | --- | --- |
| Reuse the preparation channel for reveal | No new code | Changes an accepted protocol, and inherits its file-handling limits |
| A socket in the running app | Fast, two-way | A new listener and its lifecycle; the preparation ADR rejected it |
| A second, hardened request-file channel | Same launch route; strict file rules; preparation untouched | A second channel to maintain |
| Unsigned `markpdf://` links | Simple | Any page or document could make the window open and reveal granted files |
| Signed `markpdf://` links | A link that MarkPDF did not make is inert | Links die with the data directory's key |

## Decision

1. **A second request channel.** `core/agent/desktopChannel.ts` carries `reveal` and `suggest`
   requests through `session/desktop-requests/` and `--markpdf-request=<id>`. A request id is a
   UUID, and every path is built from it. The directory is private. A file is read through one
   descriptor opened with `O_NOFOLLOW`, checked with `fstat`, and read only up to 16 KiB. The
   desktop takes a request by renaming it, so it is acted on once. It acknowledges first, so that
   a client facing an older MarkPDF says so in 5 seconds. Answers are written under a random
   temporary name and renamed into place. Old files are cleared at start.
2. **The desktop decides again.** `electron/agentRequestTargets.ts` applies the consent record to
   every request, whatever the client checked. A reveal or a suggestion needs a read grant on the
   document's file, also for a tab that is open and also for an indexed document, because the
   window matches the quote against the live document (finding R2). A reference must name a tab of
   this process. A path open in two tabs is refused as ambiguous.
3. **Reveal changes nothing.** The mark is not an overlay. It is never saved, never in the undo
   history, and gone after 7 seconds.
4. **Signed links.** `markpdf://reveal?v=1&doc=<content hash>&page=<n>&q=<quote>&sig=<HMAC>`. The
   key is 32 random bytes in `<data dir>/agent-link.key`, mode `0600`. The quote travels whole; a
   link that would need a shortened quote is not made. A link names the document by its content
   hash, never by a path. Opening the document it names needs a read grant, checked on click.
5. **A link inside a document never reaches the desktop.** `markpdf:` is not in the scheme rule of
   the window or of main, and both lists carry a comment that says why it must never be added.
6. **Cold start.** A request or a link that starts MarkPDF is decided before any window exists. A
   refusal, or a link that MarkPDF did not make, ends the process without a window.

## Consequences

- `markpdf reveal`, MCP `reveal`, and a clicked link all show a passage the same way. The warm
  call-to-reply time measured 258 ms in `tests/e2e/agent-reveal.spec.ts`.
- A reveal can open a document and start MarkPDF, only within the read grants. Opening it has the
  same effect as the person opening it, which includes automatic indexing.
- Any process of the same user can still write a request or read the link key. These files do not
  authenticate the agent. The grant checks protect the person's files.
- A link stops working when the index no longer knows its content hash, or when the data directory
  changes. The answer that carried it still names the document, the page and the quote.
- The scheme is registered for macOS only (`package.json` `build.mac.protocols`). Windows and Linux
  registration is not done.
- A link clicked while the document's file has changed still reveals the page. The label does not
  yet say that the document changed after the link was made.

## Verification

The results of these tests, and which have not run yet, are in the "Implementation record" of
`docs/agent-evidence-and-comments-plan.md`.

- `tests/e2e/agent-reveal.spec.ts`: the passage is shown and the document stays unchanged; a
  granted document is opened and an ungranted one refused; a request file written directly is
  refused by the desktop's own grant check; a request that starts MarkPDF opens its document.
- `tests/e2e/agent-evidence-link.spec.ts`: a link opens the passage with the tab open and after it
  closed; a forged link and a link in a PDF or a Markdown file do nothing; a cold start opens a
  valid link and exits for a forged one.
- `core/agent/desktopChannel.test.ts`, `core/agent/desktopRequests.test.ts`,
  `core/agent/evidenceLink.test.ts`, `electron/agentRequestTargets.test.ts`,
  `electron/externalUrl.test.ts`, `src/pdf/quoteAnchor.test.ts`, `cli/journeys/reveal.test.ts`.
- Mutation proofs: the desktop's grant check, the open-tab grant check, the process check, one-time
  consumption, the link verifier, the scheme rule, and a reveal that adds an overlay. Each failed
  its named test and passed again when restored.
