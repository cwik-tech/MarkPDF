# Following a Markdown document's links to its own sections

## Status

Accepted.

## Context

A Markdown file written for people routinely carries its own table of contents:
`- [Installation](#installation)`. The preview rendered those links as links and they went nowhere.
Nothing in the preview carried an `id`, so the anchor had no target, and every link was rendered
with `target="_blank"` — so clicking a contents row asked Electron for a new window and produced a
second, empty MarkPDF instead of moving to the section. Denying that window (see
`2026-09-07-Opening-A-Document-Web-Link.md`) removed the wrong behaviour without adding the right
one, which made the gap worth closing rather than worth recording.

Nothing in a Markdown file states which heading an anchor refers to. The writer expects the heading
to answer to the words it says, because every renderer they have used behaves that way.

## Decision

Name every heading after the words it reads as, and treat a bare `#…` link as a request to move to
that heading inside the open document.

One rule, `headingSlug`, applied to both ends. It reads a heading as text rather than as markup, so
`## The **big** idea` is named `the-big-idea`; it lowercases, drops punctuation, and joins words
with hyphens; and it keeps letters and digits in any script, because a heading in one is no less a
heading. A repeated title is numbered, and the number is checked against the names already given
out, so a document containing "Notes", "Notes 1" and "Notes" cannot give two headings the same id —
which would send a link to whichever the browser found first.

A link's anchor goes through the same rule, so a row written with the heading's own capitals and
spacing still arrives — including `[Later](<#What's next?>)`, since angle brackets are the only way
CommonMark lets a destination contain spaces, and a heading with spaces in its title cannot be
linked any other way by someone who has not memorised the naming rule. Unwrapping them is
`cleanMarkdownUrl`, which now sits beside the tokenizer that produced the brackets rather than in
one of the two places that read a destination, so the two cannot disagree about where a link points.
`notes.md#section` is not an anchor: it names a heading in another file, which is the separate
capability the other ADR records as an open gap.

A link that stays in the document is rendered without `target`, and one delegated handler on the
preview scrolls to the heading. One handler rather than one per link, because a table of contents is
as many links as the document has sections and each does the same thing. The lookup is scoped to
the preview that was clicked, since two open documents can name a section the same way, and the
click is always claimed — a link to a heading the document does not have must not fall through and
become a navigation.

The following tests verify the decision:

- `src/markdown/headingAnchors.test.ts` — the naming rule, duplicate titles, and which links count
  as anchors.
- `src/markdown/markdownAnchors.test.tsx` — the two ends meeting in the rendered markup, including
  that a link staying in the document asks for no new window while one leaving it still does.
- `tests/e2e/markdown-section-links.spec.ts` — `follows a Markdown document's contents links to the
  sections they name`, which is where the pane actually scrolling can be observed.

## Consequences

A Markdown document's table of contents works, and so does any other link it makes to its own
sections. The reader stays in the document: no new window, and no navigation, so the address the
window is on is unchanged.

Heading ids are derived, not stored, so they change when a heading is retitled — the same as every
other renderer, and the same as the link that would have to be retitled with it.

A link to a section that does not exist does nothing at all. It is claimed and then found to name
no heading. That is quieter than telling the reader their document has a broken link, and it is the
same silence a relative link to another file still produces; both are worth revisiting together
rather than one at a time.

## Alternatives Considered

- **Let the browser follow the anchor natively.** Rejected: it puts a fragment on the window's own
  address, which is a navigation in an application whose address means nothing to the reader, and it
  scrolls whichever ancestor it decides is scrollable rather than the document's pane.
- **Give each heading a generated identifier rather than a derived one.** Rejected: an anchor a
  writer typed by hand has to match, and only a rule derived from the heading's own words can be
  matched by someone who has never seen the rendered output.
- **Keep a document's own explicit anchors (`<a name>` or `{#custom-id}`).** Not decided here.
  Neither is parsed by this renderer today, and adding one is a change to what the document format
  means rather than to how a link is followed.
