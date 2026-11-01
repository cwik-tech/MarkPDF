import { describe, expect, it } from "vitest";
import { outputBudget, renderReply } from "../output/budget.js";
import { buildCommentsReply, readComments, type CommentEntry } from "./commentsReply.js";
import { buildReviewedContract } from "./reviewedContract.test-support.js";

function entry(index: number, note: string): CommentEntry {
  return {
    id: `comment-${String(index)}`,
    page: 1,
    type: "comment",
    origin: "other_application",
    author: "Reviewer",
    note,
    quote: null,
    quoteSource: null,
    modified: null,
    replyTo: null,
  };
}

const CONTENT = outputBudget(20_000);
const REPLY = outputBudget(48_000);

function reply(entries: readonly CommentEntry[], offset: number, budgets = { content: CONTENT, reply: REPLY }) {
  return buildCommentsReply({
    name: "contract.pdf",
    documentHash: "a".repeat(64),
    entries,
    offset,
    contentBudget: budgets.content,
    replyBudget: budgets.reply,
  });
}

function idsOf(payload: Record<string, unknown>): string[] {
  const comments = payload.comments;
  if (!Array.isArray(comments)) throw new Error("No comments in the reply");
  return comments.map((comment: unknown) => String(typeof comment === "object" && comment !== null ? Reflect.get(comment, "id") : ""));
}

describe("buildCommentsReply", () => {
  it("returns every comment of one crowded page through nextOffset, once each and in order", () => {
    const entries = Array.from({ length: 60 }, (_, index) => entry(index, `Note ${String(index)} `.repeat(100)));
    const seen: string[] = [];
    let offset: number | null = 0;
    let calls = 0;
    while (offset !== null) {
      const payload = reply(entries, offset);
      seen.push(...idsOf(payload));
      offset = typeof payload.nextOffset === "number" ? payload.nextOffset : null;
      calls += 1;
      expect(calls).toBeLessThan(60);
    }
    expect(calls).toBeGreaterThan(1);
    expect(seen).toEqual(entries.map((item) => item.id));
  });

  it("cuts one oversized note instead of stalling on it", () => {
    const entries = [entry(0, "x".repeat(100_000)), entry(1, "short")];
    const first = reply(entries, 0);
    const comments = first.comments as Array<Record<string, unknown>>;
    expect(comments[0]?.noteTruncated).toBe(true);
    expect(Buffer.byteLength(String(comments[0]?.note), "utf8")).toBeLessThanOrEqual(4_000);
    expect(idsOf(first)).toContain("comment-0");
  });

  it("stays inside the reply bound after JSON escaping doubles every character", () => {
    const entries = Array.from({ length: 40 }, (_, index) => entry(index, '"\\'.repeat(1_500)));
    const small = { content: CONTENT, reply: outputBudget(16_000) };
    const payload = reply(entries, 0, small);
    expect(Buffer.byteLength(renderReply(payload), "utf8")).toBeLessThanOrEqual(16_000);
    expect(payload.truncated).toBe(true);
    expect(typeof payload.nextOffset).toBe("number");
    expect(idsOf(payload).length).toBeGreaterThan(0);
  });

  it("reports what remains, and nothing remains on the last page", () => {
    const entries = [entry(0, "one"), entry(1, "two")];
    expect(reply(entries, 0)).toMatchObject({ totalComments: 2, truncated: false, nextOffset: null });
    expect(reply(entries, 1)).toMatchObject({ totalComments: 2, offset: 1, nextOffset: null });
    expect(idsOf(reply(entries, 5))).toEqual([]);
  });
});

describe("readComments", () => {
  it("names the saved file it read, so a changed file is visible between two pages", async () => {
    const original = await buildReviewedContract();
    const changed = new Uint8Array([...original, 0x0a]);
    const first = await readComments(original);
    const second = await readComments(changed);
    expect(first.documentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.documentHash).not.toBe(first.documentHash);
    expect(first.entries.map((item) => item.quoteSource)).toEqual(["text_under_marks", "text_under_marks", "text_under_marks"]);
  });
});
