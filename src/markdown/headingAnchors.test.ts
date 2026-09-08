import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdownDocument";
import { anchorTargetId, headingAnchorIds, headingSlug } from "./headingAnchors";

/**
 * What a link to a section in the same document points at.
 *
 * Two halves of one rule. A heading has to carry a name, and a link written as `#getting-started`
 * has to arrive at the same name — so both sides are put through the same function rather than
 * matched against each other by eye. The document is written by a person, so the interesting cases
 * are the ordinary ones: punctuation in a heading, two sections called the same thing, and an
 * anchor typed with the capitals the heading had.
 */
describe("naming a heading so a link can reach it", () => {
  it("names a heading after the words it says", () => {
    expect(headingSlug("Getting Started")).toBe("getting-started");
  });

  it("names it after what the heading reads as, not the markup it is written with", () => {
    expect(headingSlug("The **big** idea")).toBe("the-big-idea");
    expect(headingSlug("Using `parseMarkdown`")).toBe("using-parsemarkdown");
    expect(headingSlug("See [the appendix](appendix.md)")).toBe("see-the-appendix");
  });

  it("drops the punctuation a sentence carries and keeps the numbers", () => {
    expect(headingSlug("What's next?")).toBe("whats-next");
    expect(headingSlug("Step 2: install the CLI")).toBe("step-2-install-the-cli");
  });

  it("keeps letters that are not English, which a heading is as likely to use", () => {
    expect(headingSlug("Übersicht")).toBe("übersicht");
    expect(headingSlug("变更记录")).toBe("变更记录");
  });

  it("collapses the spacing a heading was typed with", () => {
    expect(headingSlug("  Release   notes  ")).toBe("release-notes");
  });
});

describe("giving every heading in a document its own name", () => {
  it("names each heading in the document", () => {
    const blocks = parseMarkdown(["# Guide", "", "Text.", "", "## Install", ""].join("\n"));

    expect([...headingAnchorIds(blocks)]).toEqual([
      [0, "guide"],
      [2, "install"],
    ]);
  });

  it("tells two sections with the same title apart", () => {
    const blocks = parseMarkdown(["## Notes", "", "## Notes", "", "## Notes", ""].join("\n"));

    expect([...headingAnchorIds(blocks).values()]).toEqual(["notes", "notes-1", "notes-2"]);
  });

  it("does not hand out a name a heading of its own already has", () => {
    // "Notes 1" is a real heading, so the second "Notes" cannot take `notes-1` from it: two
    // headings sharing an id is a link that lands on whichever the browser finds first.
    const blocks = parseMarkdown(["## Notes", "", "## Notes 1", "", "## Notes", ""].join("\n"));
    const ids = [...headingAnchorIds(blocks).values()];

    expect(new Set(ids).size, "distinct names").toBe(3);
    expect(ids[0]).toBe("notes");
    expect(ids[1]).toBe("notes-1");
  });

  it("still names a heading that is nothing but punctuation", () => {
    const blocks = parseMarkdown(["## ---", "", "## ???", ""].join("\n"));
    const ids = [...headingAnchorIds(blocks).values()];

    expect(ids.every((id) => id.length > 0), "every heading is reachable").toBe(true);
    expect(new Set(ids).size).toBe(2);
  });

  it("names nothing in a document with no headings", () => {
    expect(headingAnchorIds(parseMarkdown("Just a paragraph.")).size).toBe(0);
  });
});

describe("recognising a link that points inside this document", () => {
  it("reads the heading a `#` link names", () => {
    expect(anchorTargetId("#getting-started")).toBe("getting-started");
  });

  it("reads it through the same rule the heading was named by", () => {
    // So a link written with the heading's own capitals and spaces still arrives.
    expect(anchorTargetId("#Getting Started")).toBe("getting-started");
    expect(anchorTargetId("#What's next?")).toBe("whats-next");
  });

  it("reads an anchor written inside angle brackets, which is how a title with spaces is linked", () => {
    // CommonMark's own way to write a destination containing spaces. A heading called "What's
    // next?" cannot be linked any other way without the writer knowing the naming rule by heart.
    expect(anchorTargetId("<#What's next?>")).toBe("whats-next");
    expect(anchorTargetId("<#getting-started>")).toBe("getting-started");
    expect(anchorTargetId("  <#getting-started>  ")).toBe("getting-started");
  });

  it("does not mistake a bracketed address for one that stays in the document", () => {
    expect(anchorTargetId("<https://example.invalid/reference>")).toBeNull();
    expect(anchorTargetId("<notes.md#section>")).toBeNull();
  });

  it("reads an anchor that arrived percent-encoded", () => {
    expect(anchorTargetId("#%C3%9Cbersicht")).toBe("übersicht");
  });

  it("ignores an address that leaves this document", () => {
    for (const url of [
      "https://example.invalid/reference",
      "mailto:records@example.invalid",
      "notes.md",
      "../appendix/notes.md",
      "notes.md#section",
      "",
      "#",
      "   ",
    ]) {
      expect(anchorTargetId(url), url).toBeNull();
    }
  });

  it("ignores an anchor that names nothing once the punctuation is dropped", () => {
    for (const url of ["#???", "#!!!", "#..."]) {
      expect(anchorTargetId(url), url).toBeNull();
    }
  });

  it("keeps the hyphens an anchor is built out of", () => {
    // A heading named by this rule is joined with hyphens, so an anchor cannot drop them and still
    // match one. `#---` is a link to a heading that really is called that, not to nothing.
    expect(anchorTargetId("#step-by-step")).toBe("step-by-step");
    expect(anchorTargetId("#---")).toBe("---");
  });
});
