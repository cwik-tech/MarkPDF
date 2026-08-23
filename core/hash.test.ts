import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import { contentHash } from "./hash.js";

describe("document content hashing", () => {
  it("produces the same digest the renderer's crypto.subtle produced, so existing rows stay addressable", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 77]);
    // Independently computed with WebCrypto, the API src/semanticIndex.ts used.
    const reference = await webcrypto.subtle.digest("SHA-256", bytes);
    const expected = Array.from(new Uint8Array(reference))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(contentHash(bytes)).toBe(expected);
  });

  it("hashes a known input to its published SHA-256, from an independent source", () => {
    // echo -n "abc" | shasum -a 256
    expect(contentHash(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
