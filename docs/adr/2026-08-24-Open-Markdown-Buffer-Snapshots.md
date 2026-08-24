# Open Markdown buffer snapshots

## Status

Accepted. This supersedes the page-position and Markdown-refusal decisions in
`2026-08-23-Open-Document-Awareness.md`.

## Context

The first open-document implementation listed Markdown tabs but refused to read them. It also
dropped a PDF tab's current page. An assistant could identify a tab but could not read the notes
beside a PDF or tell which PDF page the person was discussing. Reading a Markdown file from its
path would bypass the open-tab authority and require separate filesystem access.

The renderer owns the current Markdown buffer. The MCP server is a separate process and cannot
reach React state. Putting the buffer in the existing window metadata JSON would make every listing
read document text and would mix a small discovery record with content up to several megabytes.

## Decision

### An open tab grants access to that tab's loaded Markdown text

MarkPDF treats the open tab itself as the authority for this local, cross-process read. The tool
never returns the saved path. Closing the tab removes the authority and its content snapshot.

This does not grant general filesystem access. PDF fallback reads still use the existing allowlist,
and no MCP tool can open an arbitrary Markdown path through this mechanism.

### Content stays separate from discovery metadata

Each window keeps its metadata at `<dataDir>/session/open-documents/<pid>-<window>.json`. Each open
Markdown buffer gets a separate private file under `open-documents/content/`. Both use mode `0600`
and atomic rename from a `mkdtemp` sibling.

The JSON record carries only counts and state: `hasContentSnapshot`, `contentChars`, `contentBytes`,
and `snapshotTruncated`. `list_open_documents` therefore does not load or return document text.
`read_open_document` loads only the snapshot named by the selected opaque ref.
The expanded metadata shape is snapshot version 2, so another version is skipped rather than read
under the wrong contract.

The local snapshot ceiling is 5,000,000 UTF-8 bytes. Truncation stops at a Unicode code-point
boundary and is disclosed. This ceiling is separate from the smaller per-reply content budget.
Successive calls use UTF-16 offsets, matching JavaScript string slicing, and concatenate to the
exact stored source.

### Snapshot lifetime follows the tab

Opening a Markdown tab writes its snapshot. Closing a tab removes its file. Reloading or closing a
window removes that window's files, and clean process exit removes the process's files. A reader
ignores and deletes both metadata and content owned by a process that no longer exists.

The main process compares Markdown content separately from the open-document report. A PDF page
turn still updates `currentPage`, but it does not rewrite unchanged Markdown files. Page-only
reports use a longer debounce than tab, content, and save-state changes.

### Markdown tabs remain read-only

The renderer shows one rendered Markdown preview. It publishes the already loaded Markdown text to
the private snapshot without exposing an editor or a Markdown Save action. PDF-to-Markdown export
continues to use `file:write-markdown`; that export path does not make an open Markdown tab
editable.

## Consequences

- An assistant can read the Markdown text loaded in an open tab and can paginate long documents
  without a path.
- `list_open_documents` reports the current PDF page and enough Markdown size information to plan
  reads without returning text.
- At most five megabytes per open Markdown tab is duplicated in the application data directory.
  Clean lifecycle handling and stale-process cleanup bound its lifetime.
- The single `read_open_document` schema accepts `pages` and `offset`. Runtime kind checks reject
  `pages` for Markdown and positive offsets for PDFs. Offset zero is the published default, so an
  explicitly supplied zero cannot be distinguished from omission and is harmless for a PDF.

## Alternatives considered

- Read Markdown through the filesystem allowlist. This bypasses the open-tab authority and requires
  separate permission for the file's path.
- Put the whole buffer in window metadata. This makes tab listing read large document content and
  couples discovery to content storage.
- Add a socket between Electron and MCP. This adds a server lifecycle and platform-specific
  transport work for state that private atomic files already represent reliably.
- Store only one reply-sized prefix. The rest of a long open document would be permanently
  unreachable, even across paginated calls.

## Verification

- `tests/e2e/open-document-context.spec.ts` exercises the read-only preview, disabled Markdown Save
  action, page navigation, MCP listing and reading, and path privacy through the real Electron and
  stdio boundaries.
- `src/openDocuments.test.ts` covers current-page projection, content projection, and debounce
  selection.
- `core/session/openDocumentsRequest.test.ts` validates page and content fields at the IPC boundary.
- `core/session/openDocumentContent.test.ts` covers the full file lifecycle, permissions, ceiling,
  Unicode truncation, traversal resistance, and dead-process deletion.
- `core/output/budget.test.ts` proves offset pagination reconstructs the exact source.
- `mcp/openDocumentOperations.test.ts` covers listing metadata, saved and unsaved reads, pagination,
  missing snapshots, ceiling disclosure, and cross-kind argument refusal.
- Mutation checks removed process-liveness enforcement, reduced the snapshot ceiling to 20,000
  bytes, deleted the snapshot on Save, and added a path to a successful Markdown reply. Each made
  its focused or Electron test fail before the implementation was restored.
