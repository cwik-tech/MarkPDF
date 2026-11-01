# Showing evidence and working with comments through an agent

MarkPDF gives an agent three tools for a document a person is reading. The agent can show the
person a cited passage, read the comments and highlights in the document, and suggest new ones. The
person accepts or rejects each suggestion. No tool writes a file, and no tool can add a grant.

Give the grants first, as separate commands:

```sh
markpdf --allow-read ~/Contracts
```

## Show a cited passage

```sh
markpdf reveal --ref active --page 12 --quote "Termination requires 30 days notice"
markpdf reveal --path ~/Contracts/msa.pdf --page 12 --quote "..." --mode link --json
```

MCP: `reveal` with `path`, `id` or `ref`, plus `page`, `quote` and `mode`.

- MarkPDF comes forward at the page and marks the quoted words for about 6 seconds. The toast says
  "Shown by AI agent · <name>, page <n>". The document does not change.
- A document that is not open opens in the front window. A closed MarkPDF starts.
- The reply says `shown` (quote found), or `page_only` (page shown, quote not found), and how
  often the quote occurs on the page. Make an ambiguous quote longer.
- Every reveal needs a read grant on the file, also for an open or indexed document.
- For an indexed document, the reply carries `link`: a `markpdf://reveal?...` address to put in an
  answer. `--mode link` returns only the link, shows nothing, and needs only the index.

A link opens the passage when the person clicks it, if the app that shows the answer makes it
clickable. MarkPDF accepts only links that its own data directory signed. A link in a PDF or a
Markdown file does nothing, and opening the document a link names needs a read grant at the time of
the click. Registration of the scheme is macOS only.

## Read comments and highlights

```sh
markpdf comments --path ~/Contracts/msa.pdf --json
markpdf comments --ref active --offset 40 --json
```

MCP: `read_comments` with `path`, `id` or `ref`, plus `pages` and `offset`.

Each item has `page`, `type`, `origin` (`person_in_markpdf`, `agent_via_markpdf` or
`other_application`), `author`, `note`, `quote` (the marked words, a best effort) and `replyTo`.
The reply is bounded. When `nextOffset` is a number, call again with that offset. When
`documentHash` changes between two calls, the file changed: start again at offset 0. Long notes and
quotes are cut at 4000 bytes and say so.

The reply describes the saved file. For an open tab it also says `unsavedChanges`, and lists the
person's decision about each agent suggestion as `pending`, `accepted`, `rejected` or `discarded`.
`accepted` is a decision, not proof that the annotation is still there.

## Suggest a highlight or a comment

```sh
markpdf suggest --ref active --page 3 --quote "30 days notice" --note "Clause 9 says 60 days."
```

MCP: `suggest_annotation` with `path`, `id` or `ref`, plus `page`, `quote` and `note`.

| `quote` | `note` | The person sees |
| --- | --- | --- |
| Yes | Yes | A comment on the quoted words |
| Yes | No | A highlight of the quoted words |
| No | Yes | A note pinned to the top of the page |

- The document must be open in exactly one tab. A suggestion never opens a document or a window.
- The suggestion shows as a dashed violet mark with a robot pin, and in the comments pane under
  "Suggested by agents" with Accept and Reject.
- Nothing reaches the file until the person accepts the suggestion and saves.
- A saved agent annotation names `<agent> (AI agent)` as its author and "AI agent comment" or
  "AI agent highlight" as its subject, in every PDF reader.
- At most 50 suggestions wait in one tab. A page insert, delete or move ends them. Closing the tab
  or the window asks the person first.
- The agent name comes from the MCP handshake, or from `--agent` on the command line. It is a
  label, not an identity.

## Refusals

| Reason | What to do |
| --- | --- |
| `access_denied` | Ask the person to grant the folder with `markpdf --allow-read`. |
| `stale_ref` | Call `list_open_documents` again. |
| `ambiguous` | Name the tab with a `ref`. |
| `not_open` | Ask the person to open the document. |
| `not_indexed` | Prepare the document for a link. |
| `quote_not_found` | Check the page, or send the note without a quote. |
| `limit_reached` | Ask the person to review the waiting suggestions. |
| `no_answer` | Restart MarkPDF. An older MarkPDF does not know these requests. |

Design and verification: `docs/agent-evidence-and-comments-plan.md`,
`docs/adr/2026-10-31-Agent-Evidence-Reveal-And-Links.md` and
`docs/adr/2026-10-31-Agent-Suggested-Annotations.md`.
