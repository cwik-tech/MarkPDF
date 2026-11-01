import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceLinkKeyPath } from "../paths.js";
import { makeEvidenceLink, parseEvidenceLink, readOrCreateLinkKey } from "./evidenceLink.js";

const HASH = "a".repeat(64);
let dataDir: string;

beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-link-")));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function link(quote = "Termination requires notice"): string {
  const made = makeEvidenceLink(readOrCreateLinkKey(dataDir), { contentHash: HASH, page: 3, quote });
  if (!made.ok) throw new Error(made.reason);
  return made.link;
}

describe("evidence links", () => {
  it("makes a link this data directory accepts, carrying the document, page and whole quote", () => {
    const made = link();
    expect(made.startsWith("markpdf://reveal?")).toBe(true);
    expect(parseEvidenceLink(made, readOrCreateLinkKey(dataDir))).toEqual({
      ok: true,
      contentHash: HASH,
      page: 3,
      quote: "Termination requires notice",
    });
  });

  it("refuses a link with any field changed, or signed with another key", () => {
    const key = readOrCreateLinkKey(dataDir);
    const made = link();
    const url = new URL(made);
    for (const [name, value] of [["doc", "b".repeat(64)], ["page", "4"], ["q", "Termination requires no notice"], ["v", "2"]] as const) {
      const changed = new URL(made);
      changed.searchParams.set(name, value);
      expect(parseEvidenceLink(changed.href, key).ok, name).toBe(false);
    }
    const otherDir = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-link-other-")));
    try {
      expect(parseEvidenceLink(url.href, readOrCreateLinkKey(otherDir))).toMatchObject({ ok: false });
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("refuses a repeated or unknown parameter, another host or scheme, and a page out of range", () => {
    const key = readOrCreateLinkKey(dataDir);
    const made = link();
    const refused = [
      `${made}&page=3`,
      `${made}&extra=1`,
      made.replace("markpdf://reveal?", "markpdf://open?"),
      made.replace("markpdf://", "https://"),
      "markpdf://reveal?v=1",
      "not a link",
      `markpdf://reveal?${"x".repeat(5_000)}`,
    ];
    for (const value of refused) expect(parseEvidenceLink(value, key).ok, value.slice(0, 60)).toBe(false);
  });

  it("refuses to make a link it would have to shorten, rather than point at another occurrence", () => {
    const made = makeEvidenceLink(readOrCreateLinkKey(dataDir), { contentHash: HASH, page: 3, quote: "€".repeat(500) });
    expect(made).toEqual({ ok: false, reason: "quote_too_long" });
  });

  it("keeps one private key and never replaces it", () => {
    const first = readOrCreateLinkKey(dataDir);
    const again = readOrCreateLinkKey(dataDir);
    expect(again.equals(first)).toBe(true);
    expect(first.length).toBe(32);
    expect(statSync(evidenceLinkKeyPath(dataDir)).mode & 0o777).toBe(0o600);
    expect(readFileSync(evidenceLinkKeyPath(dataDir)).equals(first)).toBe(true);
  });
});
