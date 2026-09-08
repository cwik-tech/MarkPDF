import { cleanMarkdownUrl, tokenizeInline, type Block } from "./markdownDocument";

/**
 * The names a document's own headings go by, so a link can point at one.
 *
 * A Markdown file written for people routinely contains its own table of contents —
 * `[Installation](#installation)` — and the anchor is the only thing tying the two ends together.
 * Nothing in the file states it: the writer expects the heading to answer to the words it says, and
 * every renderer they have used behaves that way. So the rule here is that convention, applied to
 * both ends by the same function, rather than an agreement the document has to spell out.
 */

/** What a heading with no usable characters is called, so it is still reachable. */
const UNNAMED_HEADING = "section";

/**
 * The plain words a heading reads as, with its markup removed.
 *
 * A heading is inline Markdown like any other line — `## The **big** idea`, `## Using \`parse\`` —
 * and a reader writing a link to it writes what they see, not the asterisks. An image contributes
 * nothing: its alt text is a description of a picture, not part of the title.
 */
function headingText(text: string): string {
  return tokenizeInline(text)
    .map((token) => (token.kind === "image" ? "" : token.text))
    .join("");
}

/**
 * A heading's name, from the words it says.
 *
 * Lower case, punctuation dropped, runs of space turned into single hyphens — the convention every
 * Markdown renderer a writer is likely to have used shares. Letters and digits are kept in any
 * script, because a heading in one is no less a heading.
 */
export function headingSlug(text: string): string {
  return headingText(text)
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replace(/\s+/gu, "-");
}

/**
 * Every heading in a document, by its position in the blocks, with a name no other heading has.
 *
 * Two sections really can be called the same thing — "Notes" under each of three chapters is
 * ordinary — and two elements sharing an id means a link lands on whichever the browser finds
 * first. So a repeat is numbered, and the number is checked against the names already given out:
 * a document with "Notes", "Notes 1" and "Notes" must not hand the third heading the second's name.
 */
export function headingAnchorIds(blocks: readonly Block[]): Map<number, string> {
  const ids = new Map<number, string>();
  const taken = new Set<string>();

  for (const [index, block] of blocks.entries()) {
    if (block.kind !== "heading") continue;
    const base = headingSlug(block.text) || UNNAMED_HEADING;
    let id = base;
    for (let suffix = 1; taken.has(id); suffix += 1) {
      id = `${base}-${suffix}`;
    }
    taken.add(id);
    ids.set(index, id);
  }

  return ids;
}

/**
 * The heading a link points at, when it points inside this document.
 *
 * Only a bare `#…` fragment. `notes.md#section` names a heading in another file, which is a
 * different capability with its own decisions to make, and refusing it here is what keeps this one
 * honest. The fragment goes through the same naming rule as the heading itself, so a link written
 * with the heading's own capitals and spaces still arrives.
 */
export function anchorTargetId(url: string): string | null {
  // Unwrapped first. A heading whose title contains spaces can only be linked as `<#Two words>`,
  // and reading the brackets as part of the address would send that link out of the document.
  const destination = cleanMarkdownUrl(url);
  if (!destination.startsWith("#")) return null;

  const fragment = destination.slice(1);
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    // A fragment that is not valid percent-encoding is used as the document wrote it. It is a name
    // to match, not an address to resolve, so there is nothing here that has to be well formed.
  }

  return headingSlug(decoded) || null;
}
