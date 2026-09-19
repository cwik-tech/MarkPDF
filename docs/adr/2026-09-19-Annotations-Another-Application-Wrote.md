# A comment the document carries is shown, not owned

## Status

Accepted.

## Context

A reader opened a contract that had been marked up in Acrobat by the other side's reviewer. The
page looked right: every highlight was there, in the right place, in the reviewer's colour. Not one
of the ten notes attached to those highlights could be reached. Acrobat listed all ten in its
Comments panel; MarkPDF showed an empty page of annotations and offered nothing to click.

The two halves of that have different causes, and both are worth stating.

The highlights appeared because PDF.js paints each annotation's own appearance stream onto the
canvas when it renders a page. Nothing in MarkPDF put them there, and nothing in MarkPDF knew they
existed.

The notes were unreachable because MarkPDF had exactly one idea of what an annotation is: an
`OverlayItem` in `markpdf-overlays:`, a base64 keyword this application writes and reads.
`extractEditableOverlays` read that keyword, and a document that had never been saved by MarkPDF
had no keyword to read. The annotations were in the place the format actually keeps them — each
page's `/Annots`, with the note in `/Contents` and the reviewer's name in `/T` — and no code path
looked there. MarkPDF *wrote* standard annotations on save, for other applications to read. It had
never read one back.

A third thing was true and easy to miss: `SidebarMode` already had a `"comments"` panel, complete
with a list and an empty state, and nothing in the application ever set that mode. There was no way
to open it.

## Decision

Read the document's own annotations on open, and show them as comments MarkPDF does not own.

`src/pdf/documentAnnotations.ts` converts one annotation, as the PDF records it, into an
`OverlayItem`. `extractDocumentAnnotations` in `src/pdf/document.ts` walks each page's `/Annots`
with pdf-lib and calls it. pdf-lib rather than PDF.js because `/NM` is what distinguishes an
annotation MarkPDF wrote from one it did not, and PDF.js does not report `/NM`.

`OverlayItem` gains two optional fields. `source: "document"` marks an overlay that came out of the
file, and `author` carries the name the other application recorded. The absence of `source` —
every overlay a reader makes here — means MarkPDF owns it, which is what every existing overlay
already meant.

**Shown, not owned** is the whole of the decision, and it decides the rest:

- `exportPdfBytes` filters `source === "document"` out before anything: before the metadata,
  before the standard annotations, before the flattened page. The document already carries the
  annotation. Writing MarkPDF's version of it beside the original would leave the same comment in
  the file twice and put this application's name where the reviewer's name is.
- The overlay paints nothing. The canvas already shows the annotation's own appearance, so a shape
  drawn here would be MarkPDF's idea of the reviewer's highlight sitting on top of the reviewer's.
  What is added is the part the canvas cannot give: a pin beside the line, a popover with the note
  and the name, and a click target over the marked words.
- It cannot be dragged, resized, retyped or deleted. Each of those would look like it changed the
  document while the saved file went on carrying the original.
- Its identity is derived from the page and the annotation's `/NM` rather than generated, so the
  same annotation is the same overlay every time the document is opened. A generated identity
  would give every note a new one on every read, and a second reading would add a second copy.

Geometry follows the annotation's `QuadPoints` — one fragment per marked run — and falls back to
`/Rect` for an annotation that marks no text, such as a sticky note. The four corners of a
quadrilateral are reduced to their extremes rather than read positionally, because the order the
specification gives and the order applications write are not reliably the same. An annotation whose
geometry cannot be trusted is dropped rather than opened somewhere the reader would have to guess
about, which is how `overlayMetadata` already treats a damaged fragment list.

Only annotation types that carry a note a reader can open are read, named in an allow list. A
link, a form field and a popup window are all annotations too, and a deny list would turn each of
them into a comment pinned to a piece of page furniture.

The Comments panel that already existed is now reachable, as a fourth button beside Pages, Outline
and Bookmarks. It lists every comment in page order, names the author of each, and opens the one
that is chosen.

## Consequences

- A document commented on in Acrobat, Preview, or by a script opens here with its comments. Each
  is a pin beside the line it marks; clicking the pin or the marked words shows the note and who
  wrote it; the Comments panel lists them all.
- A comment MarkPDF did not write cannot be edited or deleted here, and MarkPDF's own comments are
  unchanged: still editable, still deletable, still saved in the keyword and written out as
  standard annotations.
- Saving a document leaves annotations MarkPDF did not write exactly as they were — the same one
  annotation, its author's name intact — and does not copy them into MarkPDF's metadata.
  Flattening does not paint over them.
- The marked words of an imported comment take the click, so text under a highlight another
  application made is no longer selectable. This already applied to MarkPDF's own highlights.
- There is no reply thread. An annotation that replies to another (`/IRT`) is listed as a comment
  of its own rather than under the one it answers.
- A note whose annotation has no appearance stream is reachable through its pin and the Comments
  panel but leaves no mark on the page, because MarkPDF paints nothing for it.

## Alternatives considered

- **Import the annotations and let MarkPDF own them.** Rejected: saving would rewrite each one as
  a MarkPDF annotation, replacing the reviewer's name with this application's. On a document under
  negotiation, losing who said what is worse than not being able to edit their comment.
- **Read the annotations through PDF.js `getAnnotations`.** Rejected: it converts the geometry for
  free, but does not report `/NM`, so MarkPDF's own annotations could not be told from anyone
  else's and every comment in a document MarkPDF had saved would appear twice.
- **Paint the marked runs ourselves.** Rejected: the canvas has already drawn the annotation's own
  appearance, in its own colour. A second shape over it is visible as a darker band and is this
  application's guess at something the document already states.
- **Hold the imported annotations in a field of their own on the tab.** Rejected: they are
  comments, and the panel, the pin, the popover and the page-reordering arithmetic all already
  work on `overlays`. One filter in `exportPdfBytes` is a smaller surface than a parallel list
  every one of those would have to learn about.

## Verification

- `src/pdf/documentAnnotations.test.ts` covers the conversion: the note and the reviewer's name,
  the position on the page measured from the top, one fragment per marked run, corners in either
  order, the fallback to `/Rect`, a page whose box does not start at the origin, a stable identity
  across two reads, and the three reasons an annotation is dropped — no note, not a markup
  annotation, geometry that cannot be trusted.
- `src/pdf/document.test.ts` covers the document boundary: reading a file another application
  annotated, not reading MarkPDF's own annotations a second time, a save that leaves the original
  annotation alone and keeps it out of MarkPDF's metadata, and a flattened page that paints
  nothing over it.
- `tests/e2e/document-comments.spec.ts` drives the real application: the pin appears for a
  document MarkPDF never saved, opening it shows the note and the reviewer, no Delete is offered,
  and the Comments panel lists it.
- Mutation proof: removing the `source === "document"` filter from `exportPdfBytes` failed the
  save and flattening tests; making `extractDocumentAnnotations` stop skipping MarkPDF's own
  annotations failed the duplicate-reading tests. Both passed again once restored.
