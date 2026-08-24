# MCP session freshness and open-document context

## Status

Accepted. This record covers the P5 decisions of `docs/mcp-cli-electron-parity-plan.md`
(F7 — session-fresh settings and embedders, journeys B and C). The plan scopes this ADR across
P5–P8; later phases will extend it with their own decisions and verification sections.

## Context

An MCP session lives as long as the client does — hours. The server, as built, read the
application's semantic settings once when the tool context was created and cached one embedder
for the lifetime of the process. Two failures followed.

**The server kept answering under settings the person had already changed.** Rewriting the
model in the application re-indexes documents into the new model's scope, but the connected
server kept searching the old scope — and after a re-index there is nothing left in it, so the
same query that answered a moment ago answers with nothing until the editor restarts. Measured
in journey C: zero hits after the change, hits again only once the server reads settings per
call.

**The published schema disagreed with the product about `min_score`.** The command line read
the threshold from the application's settings per run; the MCP tool advertised `default: 0.3`
and filled it in at validation. The same question through the two doors ran under two different
thresholds, and the schema stated a constant the server was never meant to honour.

## Decision

### Settings are read per call, once per call, inside the call

`ToolContext.settings` is a function. `createToolContext` no longer reads the settings file at
startup — a context can exist even when the settings file cannot be opened — and each tool call
reads them once; everything inside that one call works from that one read, so the chunking
profile, the model and the threshold a search runs under cannot come from two different
readings. A read that fails refuses that one call with the settings error (the transport
already converts throws to refusals); the next call reads again, so repairing the file needs no
restart.

### Embedders are held per model, capped at two, most recent kept

`ToolContext.embedder` takes a model id and answers from a cache keyed by id, capped at
`EMBEDDER_CACHE_SIZE = 2` with least-recently-used eviction. A change of model takes effect on
the next call; the previous model survives one change of mind; the cache cannot grow with the
session's history. Eviction drops the reference — the embedding library owns its runtime's
memory, exactly as the application's own per-model map behaves.

### An explicit argument outranks the setting; absence falls back to it

`min_score` carries no published default anywhere. The option table declares
`settingsDefault: "minSemanticScore"` instead, which three readers honour the same way: the
parser fills nothing in and exposes `optionalNumber`, so the command reads
`argument ?? context.settings.minSemanticScore`; the schema generator publishes no `default`,
so validation leaves the argument absent; and the operation applies the same precedence to the
one read of the settings. The command's help says `(default: the application setting)` rather
than a number that could disagree with it. `top_k` keeps its constant — there is no setting for
it — and the table now takes it from `defaultSemanticTopK` instead of restating the literal.

### Parity is asserted, not assumed

Journey B indexes once, then runs the command line and the MCP tool with identical arguments
and requires identical passages in identical order — one store, one rule, two doors. Journey C
connects, searches, rewrites the settings, re-indexes through the command line (which reads
settings per run), and searches again over the same connection, requiring hits under the new
model where the old scope no longer has any.

## Consequences

- A person who changes the model, profile or threshold in the application sees the change in
  the assistant's very next answer, on a connection that has been open all day.
- A damaged-but-present settings file that cannot be opened refuses one call at a time instead
  of refusing to start; a missing or malformed one still falls back to defaults, as before.
- Clients validating calls against the published schema can no longer build a `min_score`
  expectation the server does not share.

## Verification

- Per-call reads and the per-model cache: `mcp/context.test.ts`.
- Precedence and one-read-per-call: `mcp/operations.test.ts`; end to end through the command
  line in `cli/commands.test.ts`, through the parser and help in `cli/parse.test.ts` and
  `cli/help.test.ts`, through the schema in `mcp/toolSchemas.test.ts` and
  `mcp/arguments.test.ts`.
- The refusal boundary: `mcp/server.test.ts`.
- Journeys B and C: `mcp/journeys/liveSettings.test.ts`.
- Mutation proof: caching the settings behind the function fails journey C; removing the cache
  cap fails the LRU test. Both restored, both suites green.
