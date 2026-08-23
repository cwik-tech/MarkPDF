import { createHash } from "node:crypto";

/**
 * SHA-256 over the whole file, lower-case hex.
 *
 * Byte-identical to the `crypto.subtle.digest` the renderer used, which is what lets the
 * existing `documents.content_hash` rows stay addressable across this migration. Unlike the
 * old implementation this does not copy the buffer first.
 */
export function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
