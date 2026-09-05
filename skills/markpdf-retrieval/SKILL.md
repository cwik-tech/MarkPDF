---
name: markpdf-retrieval
description: Use MarkPDF to answer questions from PDFs with bounded semantic retrieval. Trigger when the user mentions MarkPDF, asks about a PDF open in MarkPDF, or wants a focused answer from a PDF without loading the whole document.
---

# MarkPDF Retrieval

Prefer MarkPDF MCP tools when available. Use the CLI only when MCP is unavailable or a person must index or grant access; MCP deliberately cannot grant, index, or forget documents.

## Open PDF question

For a content question about a PDF the user has open, use exactly this initial route:

1. Call `list_open_documents`.
2. Call `search` with that document's `ref`, `top_k: 3`, and no `min_score`. Use `ref: "active"` only when the user clearly means the front document.
3. Call `read_pages` with the search result's `contentHash` and only the distinct pages from the best two hits. Add one neighboring page only if the retrieved passage is incomplete.

Do not call `outline` in this route. An open-document `ref` is not a content hash and must never be passed as `id`.

## Other MCP routes

- Use `read_open_document` for the visible page, an open Markdown buffer, or a page-specific request that does not need semantic retrieval.
- Use `outline` only when the user asks for document structure and a real path or `contentHash` is already available.
- When the user supplies a PDF path or content hash, search it directly and then read only the best-hit pages.

Do not request or reveal a filesystem path when the open-reference route works.

## CLI fallback

Use structured output and keep retrieval narrow:

```bash
markpdf search "<query>" --path "<pdf>" --top-k 5 --json
markpdf convert "<pdf>" --pages "<pages>" --mode page-preserving --json
```

If the document is not indexed, explain that indexing or read consent needs a person-present CLI action. Never widen access silently. If `markpdf` is unavailable, ask the user to install the command from MarkPDF Settings, or use MCP if it is registered.

## Answer

Answer only from retrieved evidence. Mention the relevant pages when useful. State whether MCP or the CLI was used and disclose any fallback or incomplete evidence.
