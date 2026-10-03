import { describe, expect, it } from "vitest";
import type { OverlayItem } from "../types";
import { listComments } from "./commentList";

function makeOverlay(overrides: Partial<OverlayItem> = {}): OverlayItem {
  return {
    id: "overlay-1",
    kind: "comment",
    page: 1,
    x: 72,
    y: 100,
    width: 120,
    height: 12,
    text: "A note",
    ...overrides,
  };
}

describe("the comments a document has to show", () => {
  it("is every comment, wherever it came from", () => {
    const mine = makeOverlay({ id: "mine" });
    const theirs = makeOverlay({ id: "theirs", source: "document", author: "A reviewer" });

    expect(listComments([mine, theirs]).map((comment) => comment.id)).toEqual([
      "mine",
      "theirs",
    ]);
  });

  it("leaves out everything that is not a comment", () => {
    const overlays = [
      makeOverlay({ id: "comment" }),
      makeOverlay({ id: "highlight", kind: "highlight" }),
      makeOverlay({ id: "bookmark", kind: "bookmark" }),
      makeOverlay({ id: "text", kind: "text" }),
      makeOverlay({ id: "signature", kind: "signature" }),
    ];

    expect(listComments(overlays).map((comment) => comment.id)).toEqual(["comment"]);
  });

  it("reads down the document: page first, then down the page, then across it", () => {
    const overlays = [
      makeOverlay({ id: "second-page", page: 2, y: 50 }),
      makeOverlay({ id: "lower", page: 1, y: 400 }),
      makeOverlay({ id: "upper-right", page: 1, y: 100, x: 400 }),
      makeOverlay({ id: "upper-left", page: 1, y: 100, x: 72 }),
    ];

    expect(listComments(overlays).map((comment) => comment.id)).toEqual([
      "upper-left",
      "upper-right",
      "lower",
      "second-page",
    ]);
  });

  it("does not reorder the document's own annotations while reading them", () => {
    const overlays = [
      makeOverlay({ id: "b", page: 2 }),
      makeOverlay({ id: "a", page: 1 }),
    ];

    listComments(overlays);

    expect(overlays.map((overlay) => overlay.id)).toEqual(["b", "a"]);
  });

  it("is empty for a document nobody has commented on", () => {
    expect(listComments([makeOverlay({ kind: "highlight" })])).toEqual([]);
  });
});
