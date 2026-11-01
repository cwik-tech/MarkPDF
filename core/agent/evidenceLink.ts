import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { evidenceLinkKeyPath } from "../paths.js";
import { MAX_PAGE, MAX_QUOTE_CHARACTERS } from "./desktopRequests.js";

/**
 * `markpdf://reveal` links: a citation in an agent's answer that opens the cited passage.
 *
 * The operating system delivers a `markpdf://` address from any application — a web page, an
 * email, a PDF open in another reader — and MarkPDF cannot stop that. So a link is signed with a
 * key only this data directory holds, and every link MarkPDF did not make is inert. The signature
 * also binds the page and the quote, so a link cannot be edited to point somewhere else.
 *
 * The document is named by its content hash, never by a path: a link ends up in chat transcripts,
 * and where somebody keeps their files does not belong there. The quote travels whole. A shortened
 * quote can match an earlier occurrence on the page, so a link that would need shortening is not
 * made at all.
 *
 * A link carries no authority. Opening the document it names still needs a read grant, checked by
 * the desktop when the link is clicked.
 */

export const LINK_VERSION = "1";
/** The same limit the window and the desktop apply to any address. */
export const MAX_LINK_LENGTH = 4_096;
const KEY_BYTES = 32;
const PARAMETERS = ["v", "doc", "page", "q", "sig"] as const;

export type LinkRefusal = "invalid" | "forged" | "quote_too_long";

/** The signing key, read when it exists and made, privately and only once, when it does not. */
export function readOrCreateLinkKey(dataDir: string): Buffer {
  const path = evidenceLinkKeyPath(dataDir);
  try {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const status = fstatSync(descriptor);
      if (!status.isFile() || status.size !== KEY_BYTES) throw new Error("The evidence link key is damaged.");
      const key = Buffer.alloc(KEY_BYTES);
      if (readSync(descriptor, key, 0, KEY_BYTES, 0) !== KEY_BYTES) throw new Error("The evidence link key is damaged.");
      return key;
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  try {
    // `wx`: made once. Two processes racing here both end up reading the one that won.
    writeFileSync(path, key, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") return readOrCreateLinkKey(dataDir);
    throw error;
  }
  return key;
}

function canonical(contentHash: string, page: number, quote: string): string {
  return `v${LINK_VERSION}\n${contentHash}\n${String(page)}\n${quote}`;
}

function sign(key: Buffer, text: string): Buffer {
  return createHmac("sha256", key).update(text, "utf8").digest();
}

export function makeEvidenceLink(
  key: Buffer,
  input: { contentHash: string; page: number; quote: string | null },
): { ok: true; link: string } | { ok: false; reason: LinkRefusal } {
  if (!/^[a-f0-9]{64}$/.test(input.contentHash) || !Number.isInteger(input.page) || input.page < 1 || input.page > MAX_PAGE) {
    return { ok: false, reason: "invalid" };
  }
  const quote = input.quote ?? "";
  const query = new URLSearchParams({
    v: LINK_VERSION,
    doc: input.contentHash,
    page: String(input.page),
    q: quote,
    sig: sign(key, canonical(input.contentHash, input.page, quote)).toString("base64url"),
  });
  const link = `markpdf://reveal?${query.toString()}`;
  return link.length > MAX_LINK_LENGTH ? { ok: false, reason: "quote_too_long" } : { ok: true, link };
}

/** A link this data directory made, or the reason it is refused. Nothing in a refused one is used. */
export function parseEvidenceLink(
  value: string,
  key: Buffer,
): { ok: true; contentHash: string; page: number; quote: string | null } | { ok: false; reason: LinkRefusal } {
  if (value.length > MAX_LINK_LENGTH) return { ok: false, reason: "invalid" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "markpdf:" || url.hostname !== "reveal" || url.pathname.replace(/^\/+/, "") !== "" || url.hash !== "") {
    return { ok: false, reason: "invalid" };
  }

  const names = [...url.searchParams.keys()];
  if (names.length !== PARAMETERS.length || !PARAMETERS.every((name) => names.filter((given) => given === name).length === 1)) {
    return { ok: false, reason: "invalid" };
  }
  const get = (name: (typeof PARAMETERS)[number]): string => url.searchParams.get(name) ?? "";
  if (get("v") !== LINK_VERSION) return { ok: false, reason: "invalid" };
  const contentHash = get("doc");
  if (!/^[a-f0-9]{64}$/.test(contentHash)) return { ok: false, reason: "invalid" };
  const pageText = get("page");
  if (!/^[1-9][0-9]{0,5}$/.test(pageText) || Number(pageText) > MAX_PAGE) return { ok: false, reason: "invalid" };
  const page = Number(pageText);
  const quote = get("q");
  if ([...quote].length > MAX_QUOTE_CHARACTERS || /[\u0000-\u001f\u007f]/.test(quote)) return { ok: false, reason: "invalid" };

  const given = Buffer.from(get("sig"), "base64url");
  const expected = sign(key, canonical(contentHash, page, quote));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "forged" };
  return { ok: true, contentHash, page, quote: quote.length > 0 ? quote : null };
}
