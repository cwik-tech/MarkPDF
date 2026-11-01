# Feature ideas

Date: 2026-10-31

These ideas extend MarkPDF as a tool for a person and as a tool for agents. None of them adds a
chat window or a chat bot. Each idea is a tool that a person or an agent calls.

The file references below point at the state of `main` on 2026-10-31 (commit `2125a71`).

## Current state

MarkPDF already covers the main loop. A person reads and marks up a document. An agent can
prepare, search, outline and read a document under strict read and write grants.

The gaps are at the edges of that loop:

- Search covers one document at a time.
- Search finds passages by meaning only, not by exact words.
- Agents cannot read the comments and highlights in a document as structured data.
- Agents cannot show a person where their evidence is.

## Idea 1: Search a whole library

A person can index a full folder with `markpdf index --recursive`, but each search must name one
document.

Evidence:

- `markpdf index` accepts a directory with `--recursive` (`cli/spec.ts:121-123`).
- `markpdf search` requires exactly one of `--path` or `--id` (`cli/spec.ts:150`).
- The store query filters on one `document_id` (`core/store/index.ts:983-988`).

Value:

- A person can answer "where did I read about X?" with one ranked list across all indexed PDFs.
- An agent needs one call instead of one call for each document.

Open decision: today a search of one indexed document needs no file permission, also after the
person removes the folder grant. The plan must decide whether library results include documents
whose folder grant was removed.

Risk: the current search compares the query vector with every stored passage of the document
(`core/store/index.ts:979-1014`). Its cost grows with the size of the library. Nobody has
measured it at library scale yet.

## Idea 2: Search for exact words next to search by meaning

Search by meaning is weak on exact strings, such as "clause 4.2(b)", a person's name, an invoice
number or an error code.

Evidence:

- None of the seven MCP tools does an exact-text search (README, MCP Server section).
- The SQLite library that MarkPDF bundles (`better-sqlite3` 13.0.3) supports FTS5 full-text
  search with `bm25` ranking. A short test under the Electron runtime confirmed this on
  2026-10-31. Thus the feature needs no new package.

Value: a combined ranking of exact-word results and meaning results is the usual way to make
retrieval much better. The README roadmap lists "make semantic search state-of-the-art".

## Idea 3: Let an agent show the evidence in the app

An agent cites "page 12", and the person must then find the passage. A `reveal` tool can scroll
the open MarkPDF window to the page and highlight the passage for a short time. The tool does not
change the file.

Evidence that the parts exist:

- The running app already accepts agent requests through its single-instance handler
  (`electron/main.ts:413-424`).
- Open documents already have opaque references that agents can use
  (`core/session/openDocuments.ts:107`).
- The renderer already places highlights for semantic search results
  (`core/index/search.ts:96-98`).

Extension: a `markpdf://` link can make citations in an agent's answer clickable. No URL scheme
exists today. Nothing in `electron/` calls `setAsDefaultProtocolClient`.

## Idea 4: Let agents read comments and propose new ones

Today only the renderer reads comments and highlights (`src/pdf/documentAnnotations.ts`). The MCP
tool description says that agents see annotations only after the person saves them into the PDF
(`mcp/toolSchemas.ts:229`).

Read side: a `comments` tool gives agents structured data for each comment and highlight. The
data includes the author, the page, the quoted text and the note. An agent can then summarize the
notes of a reviewer or draft replies.

Write side: an agent proposes highlights and comments in a separate "suggested" layer. The person
accepts or rejects each proposal in the comments pane. Nothing goes into the file until the person
accepts it. This keeps the current read and write grant model.

Requirement from the user: comments from agents must look different from comments from people.
A person must be able to see which comments an agent wrote, in the page and in the comments pane.

Evidence that this is practical: `core/` already loads `pdfjs-dist`
(`core/outline/documentOutline.ts`), so core can read annotations without the window.

Effort: this idea takes the most work of the five.

## Idea 5: Compare two versions of a document

`markpdf diff v2.pdf v3.pdf` lists the changed passages with their pages. The app shows the same
changes next to each other. The index already keeps the text of each page (CHANGELOG), so a
comparison can start from cached text.

Value: this fits contract review, where a document goes through several versions with comments.

## Smaller ideas

- Links between Markdown files. The CHANGELOG calls this "the next thing to fix here".
- Export of tables as CSV or JSON for agents.
- A watched folder that indexes new PDFs automatically.

## Implementation grouping

The user selected two groups. Each group has its own worktree and its own plan:

| Group | Ideas | Worktree |
| --- | --- | --- |
| Library retrieval | Idea 1 and idea 2 | `library-search` |
| Agent evidence and comments | Idea 3 and idea 4 | `agent-evidence-comments` |

Ideas 5 and the smaller ideas are not scheduled.
