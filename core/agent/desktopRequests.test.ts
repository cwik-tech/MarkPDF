import { describe, expect, it } from "vitest";
import { cleanAgentName, parseDesktopRequest, parseDesktopResult } from "./desktopRequests.js";

const ID = "12345678-1234-4234-8234-123456789012";
const NOW = 1_800_000_000_000;

function reveal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: ID,
    kind: "reveal",
    deadline: NOW + 30_000,
    target: { ref: "4242-1:tab-a" },
    page: 3,
    quote: "Termination requires notice",
    agent: "claude-code",
    ...overrides,
  };
}

describe("parseDesktopRequest", () => {
  it("accepts a reveal request and a suggestion request", () => {
    expect(parseDesktopRequest(reveal(), ID, NOW)).toMatchObject({ kind: "reveal", page: 3, target: { ref: "4242-1:tab-a" } });
    expect(
      parseDesktopRequest(reveal({ kind: "suggest", note: "Clause 9 says 60 days.", target: { path: "/a/contract.pdf" } }), ID, NOW),
    ).toMatchObject({ kind: "suggest", note: "Clause 9 says 60 days.", target: { path: "/a/contract.pdf" } });
  });

  it("refuses what a request from a newer or a hostile process could carry", () => {
    const refused: Array<Record<string, unknown>> = [
      reveal({ version: 2 }),
      reveal({ kind: "delete" }),
      reveal({ id: "12345678-1234-4234-8234-000000000000" }),
      reveal({ page: 0 }),
      reveal({ page: 2.5 }),
      reveal({ quote: "x".repeat(501) }),
      reveal({ quote: "line\nbreak" }),
      reveal({ agent: "a".repeat(65) }),
      reveal({ target: { ref: "4242-1:tab-a", path: "/a.pdf" } }),
      reveal({ target: { path: "relative.pdf" } }),
      reveal({ target: {} }),
      reveal({ deadline: NOW - 1 }),
      reveal({ kind: "suggest", quote: null, note: null }),
      reveal({ kind: "suggest", note: "n".repeat(2_001) }),
      reveal({ extra: true }),
    ];
    for (const value of refused) expect(() => parseDesktopRequest(value, ID, NOW), JSON.stringify(value)).toThrow();
  });

  it("names an expired request as expired, so the desktop can say so", () => {
    expect(() => parseDesktopRequest(reveal({ deadline: NOW - 1 }), ID, NOW)).toThrow(/expired/i);
  });
});

describe("parseDesktopResult", () => {
  it("accepts a result for the request it answers, and only that one", () => {
    expect(parseDesktopResult({ requestId: ID, status: "shown", page: 3, occurrences: 1 }, ID)).toMatchObject({ status: "shown" });
    expect(() => parseDesktopResult({ requestId: "other", status: "shown" }, ID)).toThrow();
    expect(() => parseDesktopResult({ requestId: ID, status: "done" }, ID)).toThrow();
    expect(() => parseDesktopResult({ requestId: ID, status: "refused", reason: "because" }, ID)).toThrow();
    expect(() => parseDesktopResult({ requestId: ID, status: "refused", reason: "access_denied", message: "m".repeat(2_049) }, ID)).toThrow();
  });
});

describe("cleanAgentName", () => {
  it("keeps a name a person can read, and nothing that could disguise it", () => {
    expect(cleanAgentName("  claude-code  ")).toBe("claude-code");
    expect(cleanAgentName("evil‮edoc-edualc")).toBe("evil edoc-edualc");
    expect(cleanAgentName("tab\tand\nline")).toBe("tab and line");
    expect([...cleanAgentName("é".repeat(100))]).toHaveLength(64);
    expect(cleanAgentName("⁦⁩")).toBe("AI agent");
  });
});

describe("the reveal message between the desktop and its window", () => {
  it("accepts a command for a tab or a file, and refuses anything else", async () => {
    const { parseRevealCommand } = await import("./desktopRequests.js");
    expect(parseRevealCommand({ requestId: ID, target: { tabId: "tab-a" }, page: 2, quote: null, agent: "claude-code" })).toMatchObject({ page: 2 });
    expect(parseRevealCommand({ requestId: ID, target: { path: "/a.pdf" }, page: 2, quote: "q", agent: "" })).toMatchObject({ quote: "q" });
    for (const value of [null, { requestId: ID, target: {}, page: 2, quote: null, agent: "x" }, { requestId: ID, target: { tabId: "a" }, page: 0, quote: null, agent: "x" }]) {
      expect(parseRevealCommand(value)).toBeNull();
    }
  });

  it("accepts the window's answer, and turns a malformed one into a failure", async () => {
    const { parseRevealOutcome } = await import("./desktopRequests.js");
    expect(parseRevealOutcome({ status: "shown", occurrences: 2 })).toEqual({ status: "shown", occurrences: 2 });
    expect(parseRevealOutcome({ status: "refused", reason: "invalid_page", message: "3 pages" })).toMatchObject({ reason: "invalid_page" });
    expect(parseRevealOutcome({ status: "maybe" })).toMatchObject({ status: "failed" });
  });
});

describe("the suggestion message between the desktop and its window", () => {
  it("accepts a suggestion for a tab, and refuses one with no quote and no note", async () => {
    const { parseSuggestCommand } = await import("./desktopRequests.js");
    expect(parseSuggestCommand({ requestId: ID, tabId: "tab-a", page: 1, quote: "q", note: null, agent: "claude-code" })).toMatchObject({ quote: "q" });
    expect(parseSuggestCommand({ requestId: ID, tabId: "tab-a", page: 1, quote: null, note: null, agent: "claude-code" })).toBeNull();
    expect(parseSuggestCommand({ requestId: ID, tabId: "tab-a", page: 1, quote: null, note: "n".repeat(2_001), agent: "x" })).toBeNull();
  });

  it("accepts the window's answer, and turns a malformed one into a failure", async () => {
    const { parseSuggestOutcome } = await import("./desktopRequests.js");
    expect(parseSuggestOutcome({ status: "added", suggestionId: "suggestion-1", occurrences: 1 })).toMatchObject({ status: "added" });
    expect(parseSuggestOutcome({ status: "refused", reason: "quote_not_found", message: "m" })).toMatchObject({ reason: "quote_not_found" });
    expect(parseSuggestOutcome({ status: "shown" })).toMatchObject({ status: "failed" });
  });
});
