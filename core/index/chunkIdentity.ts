import { createHash } from "node:crypto";
import type { SemanticChunkingProfile } from "../models.js";

export interface ChunkIdentityInput {
  contentHash: string;
  chunkingProfile: SemanticChunkingProfile;
  chunkingVersion: number;
  page: number;
  /** Position within the page, from zero. */
  index: number;
  /** Position within the source unit's continuation sequence, from zero. */
  partIndex: number;
  text: string;
}

/**
 * A short, stable fingerprint of what a chunk says.
 *
 * Whitespace is collapsed first, because layout is not content: a re-extraction that re-wraps a
 * paragraph must not invalidate an index that is still correct. Case is kept, because a citation
 * quotes the page.
 *
 * Sixteen hexadecimal characters is 64 bits. For the number of chunks one document produces —
 * thousands, not billions — an accidental collision is not a practical concern, and the cost of
 * one would be a stale chunk rather than a wrong citation.
 */
export function textFingerprint(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

/**
 * What makes two chunks the same chunk.
 *
 * Phase 1 keyed a chunk by the file's bytes plus its position within a page. That was not enough:
 * extraction is not deterministic, so the same file could yield different text at the same
 * position, and the reuse check would compare identical identifiers and keep the stale copy.
 * Folding the text's fingerprint in makes changed text a different chunk, so reuse fails closed.
 *
 * The readable prefix is deliberate. An opaque hash would make a stored row impossible to relate
 * to a document without a query; only the text fingerprint is opaque, because only it has to be.
 *
 * The identifier stays **model-blind**. Chunk text is sized to the catalogue floor, so it does
 * not depend on the active model — which is exactly what lets `chunk_embeddings` hold one vector
 * per model against one shared chunk, and what makes switching models a re-embed rather than a
 * re-chunk.
 */
export function chunkIdentifier(input: ChunkIdentityInput): string {
  return [
    input.contentHash,
    input.chunkingProfile,
    input.chunkingVersion,
    input.page,
    input.index,
    input.partIndex,
    textFingerprint(input.text),
  ].join(":");
}
