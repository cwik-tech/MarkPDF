import { curatedEmbeddingModels, type SemanticChunkingProfile } from "../models.js";
import type { OcrPageCandidate } from "../extract/readDocumentPages.js";

/**
 * Validation for everything arriving from the renderer.
 *
 * The renderer is not trusted: a compromised or simply buggy one must not be able to write a
 * page number that does not exist, a byte value that is not a byte, or a model identifier that
 * was never fetched. These guards construct the typed value or throw; they never coerce.
 *
 * They live in core rather than the Electron shell so they can be tested without a browser and
 * reused by the command line surface, which faces the same untrusted-input problem.
 */
export class SemanticRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticRequestError";
  }
}

const CONTENT_HASH = /^[0-9a-f]{64}$/;

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SemanticRequestError(`${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SemanticRequestError(`${what} must be a non-empty string.`);
  }
  return value;
}

export function parseContentHash(value: unknown): string {
  const text = requireText(value, "contentHash");
  if (!CONTENT_HASH.test(text)) {
    throw new SemanticRequestError("contentHash must be 64 lower-case hexadecimal characters.");
  }
  return text;
}

function requireChunkingProfile(value: unknown): SemanticChunkingProfile {
  if (value === "precise" || value === "balanced" || value === "contextual") return value;
  throw new SemanticRequestError("chunkingProfile must be precise, balanced or contextual.");
}

/** Absent means the default. Present but not a boolean is a caller error, never a false. */
function requireOptionalBoolean(value: unknown, what: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new SemanticRequestError(`${what} must be a boolean when present.`);
  }
  return value;
}

/** Every element must be a whole number in 0..255; nothing is coerced or truncated. */
function requireBytes(value: unknown, what: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (!Array.isArray(value)) {
    throw new SemanticRequestError(`${what} must be a byte array.`);
  }
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry > 255) {
      throw new SemanticRequestError(`${what} must contain only whole numbers between 0 and 255.`);
    }
  }
  return Uint8Array.from(value);
}

/**
 * OCR text the renderer contributes for pages the extractor reports as unreadable.
 *
 * This is all the renderer sends now: PDF Inspector is authoritative for page count and for
 * native Markdown, so page text no longer crosses IPC. OCR stays in the renderer as a scope
 * decision for Phase 2, not because the main process lacks the means — `@napi-rs/canvas` is a
 * direct dependency and the native stack runs there. It stays because the renderer has already
 * rasterised and scanned those pages for the visible text layer, and doing that work twice
 * would cost a second full pass for the same result.
 *
 * Strictly ascending rejects duplicates and disorder in one rule, and blank text is refused
 * outright: a candidate that carries nothing would mark a page as read when it was not.
 */
function requireOcrCandidates(value: unknown): OcrPageCandidate[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new SemanticRequestError("ocrCandidates must be an array when present.");

  const candidates: OcrPageCandidate[] = [];
  let previous = 0;
  for (const [position, entry] of value.entries()) {
    const row = requireObject(entry, `ocrCandidates[${position}]`);
    const page = row.page;
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1) {
      throw new SemanticRequestError(`ocrCandidates[${position}].page must be a whole number of at least 1.`);
    }
    if (page <= previous) {
      throw new SemanticRequestError(
        `ocrCandidates must be in strictly ascending order; ocrCandidates[${position}].page is ${page} after ${previous}.`,
      );
    }
    const text = row.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new SemanticRequestError(`ocrCandidates[${position}].text must be a non-empty string.`);
    }
    previous = page;
    candidates.push({ page, text });
  }
  return candidates;
}

export interface ParsedIndexRequest {
  jobId: string;
  bytes: Uint8Array | null;
  filePath: string | null;
  name: string;
  ocrCandidates: OcrPageCandidate[];
  chunkingProfile: SemanticChunkingProfile;
  force: boolean;
}

export function parseIndexRequest(raw: unknown): ParsedIndexRequest {
  const request = requireObject(raw, "index request");
  const source = requireObject(request.source, "index request source");

  let bytes: Uint8Array | null = null;
  let filePath: string | null = null;
  if (source.kind === "bytes") {
    bytes = requireBytes(source.bytes, "source.bytes");
    // Absent is a document with no file on disk, which is legitimate. Present but unusable is
    // not: this value becomes documents.file_path, which the CLI resolves against before
    // touching the filesystem, so silently discarding it makes a locatable document
    // unlocatable with nothing reported.
    filePath = source.path === undefined ? null : requireText(source.path, "source.path");
  } else if (source.kind === "path") {
    filePath = requireText(source.path, "source.path");
  } else {
    throw new SemanticRequestError("source.kind must be bytes or path.");
  }

  return {
    jobId: requireText(request.jobId, "jobId"),
    bytes,
    filePath,
    name: requireText(request.name, "name"),
    ocrCandidates: requireOcrCandidates(request.ocrCandidates),
    chunkingProfile: requireChunkingProfile(request.chunkingProfile),
    force: requireOptionalBoolean(request.force, "force", false),
  };
}

export interface ParsedSearchRequest {
  contentHash: string;
  query: string;
  chunkingProfile: SemanticChunkingProfile;
  topK: number | undefined;
  minScore: number | undefined;
}

export function parseSearchRequest(raw: unknown): ParsedSearchRequest {
  const request = requireObject(raw, "search request");
  const topK = request.topK;
  const minScore = request.minScore;
  if (topK !== undefined && (typeof topK !== "number" || !Number.isInteger(topK) || topK < 1 || topK > 200)) {
    throw new SemanticRequestError("topK must be an integer between 1 and 200.");
  }
  if (minScore !== undefined && (typeof minScore !== "number" || !Number.isFinite(minScore) || minScore < 0 || minScore > 0.95)) {
    throw new SemanticRequestError("minScore must be between 0 and 0.95.");
  }
  return {
    contentHash: parseContentHash(request.contentHash),
    query: requireText(request.query, "query"),
    chunkingProfile: requireChunkingProfile(request.chunkingProfile),
    topK: typeof topK === "number" ? topK : undefined,
    minScore: typeof minScore === "number" ? minScore : undefined,
  };
}

export interface ParsedDownloadRequest {
  jobId: string;
  modelId: string | undefined;
}

/**
 * Only curated models may be requested. `getCuratedEmbeddingModel` falls back to the default
 * for an unknown id, so without this an arbitrary string would be recorded in
 * `downloadedModelIds` having never been fetched.
 */
export function parseDownloadRequest(raw: unknown): ParsedDownloadRequest {
  const request = requireObject(raw, "download request");
  const modelId = request.modelId;
  if (modelId === undefined) {
    return { jobId: requireText(request.jobId, "jobId"), modelId: undefined };
  }
  const text = requireText(modelId, "modelId");
  if (!curatedEmbeddingModels.some((model) => model.id === text)) {
    throw new SemanticRequestError(`"${text}" is not a curated embedding model.`);
  }
  return { jobId: requireText(request.jobId, "jobId"), modelId: text };
}
