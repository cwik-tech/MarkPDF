# A thin MCP server over the same core

## Status

Accepted.

## Context

Phases 1 to 3 put document reading, the index, search, OCR and the consent model in `core/`, and
put a `markpdf` command over them. The command is usable by a person and by an agent that can run
a subprocess. It is not usable by an agent that speaks the Model Context Protocol, which is what
Claude Code, Claude Desktop, Codex and the Pipeline project's broker all speak.

`docs/mcp-and-agent-integration-plan.md` sets the shape: Tier 1 tools over stdio, access classes
per tool, and D9 — *output budgets and path safety live in core, not in the MCP transport.*
`docs/core-extraction-and-cli-plan.md` bounds it to exactly four tools and states the rule that
governs everything here: if the command line's schemas, identities, consent policy, page-index
boundary or budgets need changing to fit MCP, that is a signal the command line got them wrong,
not licence to fork them.

This ADR exists because the phase adds a dependency, a runtime adapter, and public tool schemas
that other people's software will validate against.

## Decision

### The dependency is the official SDK, pinned

`@modelcontextprotocol/sdk` at exactly `1.30.0`, following the repository's practice of pinning
anything on the release path to a single version rather than a range. It brings roughly 8 MB
installed and declares seventeen dependencies, among them `express`, `hono`, `jose`, `ajv`, `cors`,
`eventsource` and `pkce-challenge` — the HTTP and OAuth halves of the SDK. None of them is loaded:
the server imports `server/index.js`, `server/stdio.js` and `types.js`, and nothing else. The
client half is imported in one place, `mcp/journeys/toolSession.test.ts`, which is a test and does
not ship.

Writing the twenty lines of JSON-RPC framing by hand was considered and rejected. The protocol has
a version negotiation, a capability handshake, a cancellation notification and a progress
notification, and each is a place to be subtly wrong in a way that shows up as a client that hangs
rather than a test that fails. The acceptance journey drives the real client against the real
server over a real pipe, which is only possible because the client half is the same library.

### The low-level `Server`, not `McpServer`

`McpServer.registerTool` takes Zod schemas. These tools' schemas are **generated from the command
table** in `cli/spec.ts` — the table that already validates argv and generates `--help`. That
reuse was the deciding reason for hand-writing the table instead of taking a third-party argument
parser, and it is worth more than the convenience of the higher-level class. `Server` with
`setRequestHandler(ListToolsRequestSchema | CallToolRequestSchema)` accepts raw JSON Schema, so
`--top-k`'s range is declared once and a client validating against the published schema reaches
the same verdict the server does.

### Exactly four tools, and nothing else

`outline`, `search`, `read_pages`, `to_markdown`. No resources, no prompts, no Streamable HTTP,
and nothing from Tier 2 or Tier 3. Every tool costs context in every session of every client
forever, so the surface is the smallest one that is useful: orient, search, read what a hit points
at, convert.

Nothing here indexes, grants or deletes. **Consent is given out of band, with the command line.**
A server that could widen its own access would make the allowlist decorative, and the plan's model
is that the client's configuration file is the authorisation for the server to exist at all — not
for it to acquire more.

`read_pages` exists as a separate tool only because MCP has no flags; the same capability on the
command line is `convert --pages`.

### The access class is a named property of core, not of the adapter

`core/documents/documentPages.ts` takes an explicit `DocumentAccess`:

- `index-only` never touches the filesystem. `search` and `read_pages` are this, which is what
  makes the two highest-traffic operations need no file permission under any circumstances —
  provably, because there is no branch that could open a file.
- `index-first` answers from the index and reads the file otherwise, with permission. `outline`.
- `filesystem` proves read permission **first, always**, even when the answer will come from the
  index. `to_markdown`. A caller in this class is doing something classed as reading the file, and
  a cached copy must not become a second route around a withdrawn grant.

A boolean was the first attempt and was wrong: `to_markdown` served indexed Markdown before
checking consent, so revoking a grant did not stop it.

A request naming only a content hash resolves to the path the document was indexed from, and both
the consent check and the extraction use that same path. Deriving it twice was a real defect:
consent was proved against the stored path while extraction looked at what the caller typed, so a
document named by `id` with no cached Markdown reported as *not indexed* with a live grant in
place.

`to_markdown`'s `output_path` is a separate write grant. Permission to read a library is not
permission to write into it.

### Two output bounds, and neither is optional

D9 puts budgets in core, so `core/output/budget.ts` owns both:

- A **content** bound: how much document text an operation gathers, in UTF-8 bytes, cut on whole
  pages and whole headings. Bytes rather than characters, because twenty thousand CJK characters
  are sixty thousand bytes.
- A **reply** bound: the finished reply text, measured on the exact string the transport is
  handed.

Both are needed. Serialization is **not** fixed overhead — a claim an earlier draft of this work
made in a comment, and it was wrong. JSON escaping is content dependent (a quote, a backslash and
a newline each double; a control character becomes six bytes) and every item in a list repeats its
own keys, so four thousand two-word headings are a few kilobytes of document text and hundreds of
kilobytes of reply. Content bounding alone cannot state a true limit on what is returned; reply
bounding alone would cut in the middle of a heading.

The reply bound is honest about what it is not: it counts the JSON an operation hands to the
transport, which is the text that lands in an agent's context. The SDK then embeds that string in
a `CallToolResult` inside a JSON-RPC frame and escapes it again, so the bytes on the wire are
larger — up to roughly twice, plus an envelope. Bounding the frame would mean reaching into the
SDK's serializer for a number nobody is spending.

Three things follow that were each found by asking where the bound leaks:

- Page numbers are metadata this program produced, and they are still bytes. A twelve-hundred-page
  selection listed one page at a time is kilobytes before a word of the document appears, and the
  branch that writes to a file carries nothing else at all. Pages are summarised as `1-3,7,10-12`
  — the same vocabulary `--pages` reads, so the summary is an answer a caller can act on.
- A refusal repeats what it was given: a tool name, a path, an exception message. All of that is
  the client's own text, so refusals are bounded too — after `safeForTerminal` rather than before,
  since making text terminal-safe is what lengthens it. That is a different escaping from the JSON
  serialization the transport does afterwards.
- `callTool` checks the finished reply against the budget as a last invariant. Every operation
  fits its own reply, so nothing reaches it today; it stands between a future branch and a caller
  who was promised a limit.

The unbounded renderer still exists and is named `renderMarkdownForFile`, so reaching for it is a
visible decision about a file rather than about a reply. A boundary test refuses any mention of
the unbounded document renderer inside `mcp/`.

### Concurrency is bounded, because the SDK's is not

`@modelcontextprotocol/sdk/shared/protocol.js` starts each request handler through
`Promise.resolve` as the frame arrives and never waits for an earlier one. One process holds one
SQLite connection and one embedding session, so without a limit a client that sends twenty calls
gets twenty concurrent extractions and a peak memory decided by the client rather than by this
program.

`core/index/boundedScheduler.ts` — already used by the application to bound indexing — is reused
at the call boundary with a limit of **four**. Four rather than one, so an index-only `search` is
not stuck behind a slow conversion of a three-hundred-page scan. Four rather than many, because
embedding is synchronous native work that blocks the thread: overlapping calls do not finish
sooner, they only multiply the document text held at once.

Cancellation survives the queue. A call that was given up on while waiting never has its work
started when its turn arrives, and one already cancelled when it arrives never takes a place in
the queue.

### Every argument is unknown until it is validated here

The published schema is advisory; `mcp/arguments.ts` is not. It refuses undeclared properties
rather than ignoring them, applies the table's defaults, enforces the table's ranges, refuses
control characters with the same rule the command line applies to argv, and **derives** the
exactly-one-of identity rule from the `oneOf` the tool published rather than carrying a second
copy of it. The SDK's callback payload is treated the same way: the envelope was parsed by the
library, the `name` and `arguments` inside it were not.

### stdout belongs to the protocol

`StdioServerTransport` owns stdout. The startup banner, every diagnostic, and every uncaught fault
go to stderr. A refused tool call is an *answer* and goes into the protocol with `isError`, not to
stderr — writing it to stderr would leave a client waiting for a reply it was never going to get.

### How it is launched, and what is deferred

The client's configuration names a command, and that is the authorisation. The server is the
entry point `dist-mcp/main.js` inside the application bundle, run on the bundled Electron binary
under `ELECTRON_RUN_AS_NODE=1` — the same mechanism the command line uses, for the same reasons
recorded in the CLI packaging ADR.

**No Settings affordance and no second installed shim, deliberately.** Both are real work — an
install state machine, a status surface, a second thing that can be stale or foreign — and none of
it is protocol work. Registering an MCP server is a one-line client command that a person runs
once. The trigger for revisiting: when a second person has to be talked through the path by hand.

## Consequences

- MarkPDF is reachable from any MCP client, with no change to the index, the extractor or the
  consent model — the same database the application and the command line use.
- A dependency with a large transitive tree is on the release path. Only its stdio server half is
  imported, and `npm run package` is verified to contain and run the entry point.
- Tool schemas are now a public contract. They are generated, so the command line and the tools
  cannot drift; a change to `cli/spec.ts` changes both, which is the intended coupling.
- `mcp/` is a fourth runtime boundary in `AGENTS.md`, enforced by `core/boundaries.test.ts`.
- Two named budgets exist where there was one. Callers of `boundItems` now owe a second, reply-
  level step; the doc comment says so and the boundary test names the unbounded renderer.

## Alternatives considered

**A hand-written JSON-RPC loop, no dependency.** Rejected: the framing is the easy part, and the
handshake, version negotiation and cancellation are where being subtly wrong produces a hanging
client rather than a failing test. The acceptance journey drives the official client against this
server precisely because that is the thing worth proving, and it needs the library on both ends.

**`McpServer` with Zod schemas.** Rejected: it would mean a second, separately authored
description of arguments the command table already describes and validates. That drift is what
generating the schemas exists to prevent.

**More tools now — `index`, `grant`, `forget`, `list`, `tables`.** Rejected on two grounds. Every
tool costs context in every session forever, and a server that can grant itself access makes the
consent model decorative. Indexing and granting stay on the command line, where a person is
present.

**Streamable HTTP as well as stdio.** Deferred, per the plan. It is the transport the Pipeline
project's broker needs, and it brings a bind address, an authentication token, and a session
model. There is no second consumer yet.

**One budget instead of two.** Rejected after measuring: a content-only bound cannot state a true
limit on what is returned, and a reply-only bound cuts in the middle of a heading. Both are cheap;
the pair is what makes the promise true and the cuts sensible.

**A `markpdf mcp` subcommand.** Rejected: the command line's surface is four commands, decided in
Phase 3 and documented in its help, its README section and its exit table. A fifth command that
never returns and speaks a protocol on stdout belongs to a different contract.

## Verification

- `mcp/journeys/toolSession.test.ts` — the exit criterion. The official SDK `Client` over a real
  `StdioClientTransport` against the real server process: lists exactly four tools, orients,
  searches, reads the page a hit points at, is refused a document nobody granted with the grant
  command in the refusal, and answers about an indexed document after its grant was withdrawn
  while `to_markdown` is still refused.
- `mcp/journeys/stdoutPurity.test.ts` — every line of stdout parses as a JSON-RPC frame; the
  banner naming the data directory appears on stderr and not on stdout; a refusal arrives in the
  protocol rather than on stderr; an unparseable frame produces no stray output.
- `mcp/server.test.ts` — the call boundary: at most the limit's worth of calls do work at once, a
  queued call that was cancelled never starts, an already-cancelled call never queues, and every
  success and failure reply stays inside the declared budget for escape-heavy text, four thousand
  tiny headings, twelve hundred pages, and a four-hundred-thousand-character tool name.
- `mcp/operations.test.ts` — the access classes against a real index and the real extractor,
  including `to_markdown` by `id` with a live grant and after revocation.
- `core/output/budget.test.ts`, `core/documents/documentPages.test.ts`, `mcp/arguments.test.ts`,
  `mcp/toolSchemas.test.ts`.
- Mutation proof, each restored after: counting characters instead of UTF-8 bytes; cutting on code
  units; returning an oversized first item; extraction looking only at the path the caller typed;
  listing page numbers instead of summarising them; appending the ellipsis after fitting instead
  of reserving it; removing the reply fit from `outline` and from `read_pages`; removing the bound
  on refusal text; removing `callTool`'s last invariant; and, for the boundary rules, an Electron
  import in `mcp/`, `mcp/` reaching core sources, the command line importing `dist-mcp/`, a
  side-effect import, a dynamic import, a `require`, and a browser global in `core/`.

Named verticals: V12 (four tools over a real stdio transport), V13 (an indexed document answered
with no filesystem permission), V14 (a path outside the allowlist refused with a runnable remedy),
V15 (the packaged application contains and runs `dist-mcp/main.js`).
