# Search an indexed PDF through its open-document reference

## Status

Accepted.

## Context

`list_open_documents` gives an MCP client opaque references instead of filesystem paths, but
`search` previously accepted only a path or content hash. An assistant asked about a PDF in the
MarkPDF window therefore had to choose between reading pages without semantic retrieval or asking
the user for an identity MarkPDF already knew.

Adding the filesystem path to the listing or search reply would break the open-document privacy
contract. Adding another search tool would duplicate an operation and make clients choose between
two interfaces for the same indexed query.

## Decision

Extend the existing MCP `search` tool with a third mutually exclusive document identity: `ref`.
The value may be an opaque reference returned by `list_open_documents` or `active` for the document
currently in front. Path, content hash, and reference remain exclusive alternatives in the
published JSON Schema.

Resolve the reference from a fresh open-document snapshot for each call. Search only when it names
an indexed PDF, then pass its content hash to the existing index lookup. The private path in the
snapshot is neither needed by search nor returned in success and refusal replies. The operation
continues to read only the semantic index and retains the existing result and output-budget
contracts.

The following tests verify the decision:

- `mcp/toolSchemas.test.ts` — `lets search target an open document reference as the third exclusive identity`.
- `mcp/operations.test.ts` — `searches the active indexed document by reference without reading or returning its path`.
- `mcp/journeys/toolSession.test.ts` — `searches the active indexed PDF by its open-document reference without disclosing its path` through the official SDK and real stdio server.

## Consequences

An agent can list the user's open documents, search the selected PDF semantically, and read only the
pages returned by search without receiving a filesystem path. Existing path- and hash-based callers
remain compatible. An open Markdown tab or a PDF without an index is refused with an instruction to
index the PDF first, because semantic search has no suitable index snapshot.

Open-document references are session-scoped. A stale reference can fail after a tab closes or a
window changes, so clients should list again instead of persisting references.

## Alternatives Considered

- **Return paths from `list_open_documents`.** Rejected because it exposes private filesystem
  structure to every connected client.
- **Add a separate `search_open_document` tool.** Rejected because reference resolution is an
  identity concern, not a second semantic-search behavior.
- **Make `read_open_document` search automatically.** Rejected because page retrieval and semantic
  retrieval have different inputs, costs, and result contracts.
