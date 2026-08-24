# MCP session freshness and open-document context

## Status

Accepted. This record covers the P5 and P8 decisions of
`docs/mcp-cli-electron-parity-plan.md`: session-fresh settings and embedders, and progress for
long MCP calls.

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

**Long calls were silent.** OCR and model loading already produced progress internally, but the
MCP request boundary did not consume the SDK progress token or send a notification. A client
could therefore wait through a scanned conversion without knowing whether work was continuing.

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

### Progress belongs to the requesting call

The server creates a reporter only when the SDK supplies a string or numeric progress token. It
keeps progress nondecreasing, makes messages terminal-safe, applies the normal reply-text bound,
and sends the first update immediately. Intermediate updates are limited to one per 500 ms; the
last pending update is always sent before the tool reply completes. Notification failures do not
turn successful document work into a failed tool call.

OCR page messages are composed with any listener already present on the resolver. Embedding model
download progress uses `ModelProgressHub`: the cached embedder is the one producer, while every
call subscribes only for the duration of its own `embed` or `warm` operation. A call that joins an
in-progress model load therefore sees later bytes, and listeners do not accumulate after calls end.

## Consequences

- A person who changes the model, profile or threshold in the application sees the change in
  the assistant's very next answer, on a connection that has been open all day.
- A damaged-but-present settings file that cannot be opened refuses one call at a time instead
  of refusing to start; a missing or malformed one still falls back to defaults, as before.
- Clients validating calls against the published schema can no longer build a `min_score`
  expectation the server does not share.
- MCP clients that request progress see page-level OCR and model-download updates; clients that do
  not request it pay no notification cost.

## Verification

- Per-call reads and the per-model cache: `mcp/context.test.ts`.
- Precedence and one-read-per-call: `mcp/operations.test.ts`; end to end through the command
  line in `cli/commands.test.ts`, through the parser and help in `cli/parse.test.ts` and
  `cli/help.test.ts`, through the schema in `mcp/toolSchemas.test.ts` and
  `mcp/arguments.test.ts`.
- The refusal boundary: `mcp/server.test.ts`.
- Journeys B and C: `mcp/journeys/liveSettings.test.ts`.
- Mutation proof: caching the settings behind the function fails journey C; removing the cache
  cap fails the LRU test; dropping the reporter's final pending update fails
  `mcp/server.test.ts`. All were restored and rerun green.
- Progress reporter and producer wiring: `mcp/server.test.ts` and `mcp/context.test.ts`.
- Real SDK progress-token journey over stdio: `mcp/journeys/progress.test.ts`.
