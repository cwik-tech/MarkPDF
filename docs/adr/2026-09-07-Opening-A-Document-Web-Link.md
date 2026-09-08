# Opening a document's web link in the reader's own browser

## Status

Accepted. Supersedes the external-link exclusion in
`docs/pdf-search-highlight-and-ocr-status-plan.md`.

## Context

MarkPDF drew hitboxes only for links that stay inside the open document. A `/URI` annotation — a
footnote citing a source, a reference list, a "read more" line — rendered as underlined blue text
that did nothing when clicked. The reader could see that the document contained a link and could not
follow it. The earlier decision recorded this as deliberate, on the grounds that opening an address
needs a privileged boundary and a decision about which addresses are safe to hand to the operating
system. Both were still true; neither had been made.

`shell.openExternal` is not "open a browser tab". It hands a string to the desktop's handler
registry, which answers for far more than the web: `vscode:`, `smb:` and `ms-msdt:` start programs
with an argument the document chose, and `file:` names something on the reader's own disk. A PDF is
a file anybody can produce, so an address inside one must not be able to decide what the reader's
machine opens next.

Electron also answers `window.open` — which is what the Markdown preview's `target="_blank"` links
are — by building a second BrowserWindow with the same preload attached, unless a window-open
handler says otherwise. No handler was set.

## Decision

Admit `/Link` annotations that carry a URL, and open the address outside the application.

The address must be absolute, no longer than 4096 characters, and in one of three schemes:
`http:`, `https:`, `mailto:`. A page to read and a message to send are the only things a link in a
document is ever meant to be. Everything else produces no clickable element at all, rather than a
hitbox that fails on click.

The rule is applied twice, on both sides of the bridge:

- `src/pdf/links.ts` decides whether a link is worth drawing. It reads the `url` PDF.js produced
  from its own parse, never the raw `unsafeUrl` the file wrote, and refuses an annotation that
  carries a destination and a URL together rather than choosing between them.
- `electron/externalUrl.ts` decides what reaches the desktop. The window is not the authority on
  what this machine may launch, and the argument arrives over IPC as `unknown`.

Both return the URL parser's `href`, so the two sides compare and open one spelling of an address
rather than two. `electron/externalUrl.test.ts` holds them to identical answers, because the failure
the duplication invites is silent: a link the window draws and the main process then refuses is a
dead hitbox the reader clicks and clicks.

`createWindow` also installs a window-open handler that denies every new window and sends the
address through the same rule. A document's link can no longer produce a second privileged window.

Both paths are total. `shell.openExternal` rejects when the system has no handler for a scheme — a
`mailto:` link on a machine with no mail client is the ordinary way to meet that, not an edge case —
and its two callers are places a rejection would do real damage: the window-open handler, where
nothing is awaiting it, and a click handler in the window. So `openAddressExternally` answers
`false` rather than throwing, and the window says so with the same alert it uses when a document
cannot be opened. A click that does nothing and reports nothing is the defect this whole path exists
to remove.

The following tests verify the decision:

- `src/pdf/links.test.ts` — `admitting a link that leaves the document for the web`, which covers
  the admitted schemes, the refused ones, the length bound, and reading the validated address
  rather than the file's own string.
- `electron/externalUrl.test.ts` — `the addresses the desktop may be asked to open`, and
  `the rule the window draws links by and the rule this side opens them by`.
- `tests/e2e/pdf-native-navigation.spec.ts` — `opens a PDF's web link in the reader's browser
  instead of inside MarkPDF`, through the real annotation, hitbox, preload bridge and main-process
  rule, and on to a desktop that refuses the address: the reader is told, and the main process is
  left with no unhandled promise from either path.

## Consequences

A reader can follow a citation in a PDF to its source. The address opens in whatever they use for
the web or for mail, and MarkPDF stays where it was: same window, same page, same document.

Links in schemes MarkPDF does not open — `ftp:` and `tel:` among them, both of which PDF.js itself
accepts — are drawn as nothing. That is a visible gap for a document that uses one, and it is the
side of the trade the allow list is on: adding a scheme is a decision with a name, and widening the
list to whatever a dependency tolerates is not.

The scheme rule now exists in two files. A parity test is what keeps that safe; a third copy would
need the same treatment or a shared module, and `core/` is the wrong home for it because the rule is
about a desktop capability rather than about documents.

**A relative link to another file in the Markdown preview does nothing, and this is a gap rather
than a decision about it.** `MarkdownPreview` resolves such a link against the document's own
directory, so `[notes](notes.md)` becomes a `file:` address, and a link that leaves the document
carries `target="_blank"`. Electron used to answer that by loading the file in a second window
carrying this preload — which is exactly what the window-open handler exists to stop — so the click
now produces silence instead of an over-privileged window. Neither is right. What a reader wants is
for the linked document to open in MarkPDF, through the same path as any other file it opens, and
that is a capability with its own decisions to make about which paths a document may name. It is
not made here.

## Alternatives Considered

- **Render the address as a link element and let Electron navigate.** Rejected: a top-level
  navigation replaces the reader's document with a web page inside the application window, and a
  `target="_blank"` link opens a second window carrying the preload bridge.
- **Validate only in the main process.** Rejected because the window must decide whether to draw a
  hitbox at all, and a hitbox whose click is silently refused is worse than no hitbox.
- **Validate only in the renderer.** Rejected outright: the process that can launch a program must
  not take a window's word for what it may launch.
- **Follow PDF.js's own protocol list.** Rejected. It admits `ftp:` and `tel:`, and it is a
  dependency's decision about what is parseable, not this application's decision about what a
  document may open on someone's machine.
- **Ask the reader to confirm each address before opening it.** Rejected for now: every mainstream
  reader opens a link on click, and a confirmation on a refused-by-default scheme list adds a step
  without adding a decision the reader is equipped to make.
