# 2026-10-31 Agents read comments and suggest annotations

## Status

Accepted on 2026-10-31 under the user's instruction to implement the reviewed plan
`docs/agent-evidence-and-comments-plan.md`. Amends one alternative that
`docs/adr/2026-09-19-Annotations-Another-Application-Wrote.md` rejected.

## Context

Only the window read a document's comments. Agents could not see who wrote what, and on which
words. The user also asked that agents can propose highlights and comments, that the person accepts
or rejects each proposal, that nothing reaches the file before acceptance, and that an agent's
annotations look different from a person's — on the page, in the comments pane, and in other PDF
readers after a save.

MarkPDF wrote `/T (MarkPDF)` on every annotation it saved, so an accepted agent comment would have
named MarkPDF as its author everywhere else. Its writer also used literal PDF strings, which do not
safely carry arbitrary text (Codex finding R1).

## Decision

1. **A core reader.** `core/annotations/` reads MarkPDF's own keyword and other applications'
   `/Annots`, as the window does, and the quoted words under each mark from pdf.js text positions.
   Core cannot import the window, so the rules are repeated and
   `core/annotations/rendererParity.test.ts` holds the two readers to the same identities, pages
   and geometry. Core keeps highlights without a note; the window does not list them.
2. **Reading comments is reading the file.** `read_comments` and `markpdf comments` always need a
   read grant, also for an indexed document, because the index holds no annotations. One core
   builder bounds and paginates the reply for both surfaces.
3. **Suggestions beside the overlays, never among them.** A suggestion lives in the tab's
   `suggestions` field. The 2026-09-19 ADR rejected a separate field for imported annotations,
   because they are comments of the document. A suggestion is not, until the person accepts it.
   `exportPdfBytes` receives overlays only, so no save can write a pending suggestion, and the undo
   history, which holds overlays, cannot bring back a rejected one.
4. **Agents never write.** A suggestion needs a read grant and an open tab. It never opens a
   document or a window. The person's accept is an ordinary, undoable edit, and the person's save
   is the only write.
5. **Authorship.** An accepted suggestion becomes an owned overlay with `origin: { kind: "agent",
   agent, quote, suggestedAt, acceptedAt }`, kept in MarkPDF's keyword. The standard annotation
   gets `/T (<agent> (AI agent))`, `/Subj (AI agent comment)` or `(AI agent highlight)`, a violet
   `/C`, and UTF-16 hex strings for the agent's name and note. A person's annotation is written as
   before.
6. **Lifecycle.** A page insert, delete or move, or an undo or redo that restores other pages,
   discards every pending suggestion of the tab, because its anchor could be on the wrong page. A
   tab close or a window close asks before it discards pending suggestions. A flattened save asks
   before it drops the agent labels. The window reports ids and decisions, never text, in the
   open-documents record, so an agent can read the person's decisions back.

## Consequences

- The page shows dashed violet marks and robot pins for suggestions, and solid violet marks and
  robot pins for accepted agent annotations. The pane shows "Suggested by agents (N)" with Accept
  and Reject, and the badge "AI agent · <name>" on every agent annotation, highlights included.
  Every accessible name says "AI agent", so the difference does not rest on colour.
- The agent name is the client's own claim from the MCP handshake, or `--agent` on the command
  line. It is a label, not an identity. It is cleaned of control and bidirectional characters.
- A flattened copy cannot carry the agent's name. Its marks keep the violet colour.
- A person's annotations still say `MarkPDF` in other readers, and their notes are still written as
  literal strings. That path has the same escaping weakness for text the person types; it is
  outside this change.
- One call makes one suggestion. Batches would need array arguments, which the validator does not
  take.

## Verification

The results of these tests, and which have not run yet, are in the "Implementation record" of
`docs/agent-evidence-and-comments-plan.md`.

- `tests/e2e/agent-suggestions.spec.ts`: three suggestions, one accepted, one rejected and one left
  pending, and only the accepted one in the saved file as the agent's, also after a reopen and for
  `read_comments`; an accepted agent highlight keeps its label; a flattened export asks first; a
  page change ends pending suggestions; a tab close asks first and the file is unchanged.
- `mcp/journeys/comments.test.ts` and `cli/journeys/comments.test.ts`: authors, pages, quotes and
  notes; a refusal without a grant; the reply bound; a grant flag with the command is refused.
- `core/annotations/*.test.ts`, `src/pdf/agentSuggestions.test.ts`, `src/pdf/document.test.ts`,
  `src/pdf/overlayMetadata.test.ts`, `src/pdf/commentList.test.ts`,
  `core/session/openDocumentsRequest.test.ts`, `core/session/openDocuments.test.ts`,
  `src/openDocuments.test.ts`, `mcp/commentOperations.test.ts`.
- Mutation proofs: literal strings for agent text, `MarkPDF` as an agent's author, a dropped and an
  unchecked origin, the duplicate-skip in the core reader, the reply bound, and the refusal of
  grant flags. Each failed its named test and passed again when restored.
