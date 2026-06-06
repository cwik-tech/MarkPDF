import { env, pipeline } from "@huggingface/transformers";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import sqlWasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { extractPageText } from "./pdf/document";
import type { OcrPageText, SemanticIndexProgress, SemanticSearchResult } from "./types";
import type { SemanticSearchSettings } from "./global";
import {
  defaultSemanticScoreThreshold,
  getChunkingPreset,
  getCuratedEmbeddingModel,
  semanticChunkingVersion
} from "./semanticModels";

const textExtractionVersion = 1;
const ocrExtractionVersion = 1;
const modelVersion = "hf-transformers-js";

let sqlRuntimePromise: Promise<SqlJsStatic> | null = null;
let dbPromise: Promise<Database> | null = null;
const pipelinePromises = new Map<string, Promise<any>>();

(env as any).allowLocalModels = false;
(env as any).useBrowserCache = true;

interface DocumentIndexInput {
  name: string;
  path?: string;
  bytes: Uint8Array;
  pdfDoc: PDFDocumentProxy;
  ocrPages: OcrPageText[];
  settings: SemanticSearchSettings;
  onProgress?: (progress: SemanticIndexProgress) => void;
  isCancelled?: () => boolean;
}

interface SemanticSearchInput {
  bytes: Uint8Array;
  query: string;
  settings: SemanticSearchSettings;
}

interface PageText {
  page: number;
  text: string;
  source: "pdf" | "ocr";
}

interface TextChunk {
  id: string;
  page: number;
  index: number;
  text: string;
}

function getSqlRuntime() {
  sqlRuntimePromise ??= initSqlJs({ locateFile: () => sqlWasmUrl });
  return sqlRuntimePromise;
}

async function getDatabase() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const SQL = await getSqlRuntime();
      const existing = await window.pdfReader?.semantic.loadDatabase();
      const db = existing ? new SQL.Database(Uint8Array.from(existing)) : new SQL.Database();
      initializeSchema(db);
      return db;
    })();
  }
  return dbPromise;
}

function initializeSchema(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      file_path TEXT,
      file_size INTEGER NOT NULL,
      page_count INTEGER NOT NULL,
      text_source TEXT NOT NULL,
      text_extraction_version INTEGER NOT NULL,
      ocr_extraction_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_opened_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT PRIMARY KEY,
      document_id INTEGER NOT NULL,
      page_number INTEGER NOT NULL,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      chunking_profile TEXT NOT NULL,
      chunking_version INTEGER NOT NULL,
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chunk_embeddings (
      chunk_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector BLOB NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(chunk_id, model_id, model_version),
      FOREIGN KEY(chunk_id) REFERENCES document_chunks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_embeddings_model ON chunk_embeddings(model_id, model_version);
  `);
}

async function persistDatabase() {
  const db = await getDatabase();
  await window.pdfReader?.semantic.saveDatabase(Array.from(db.export()));
}

export async function clearSemanticIndex() {
  const db = await getDatabase();
  db.run("DELETE FROM chunk_embeddings; DELETE FROM document_chunks; DELETE FROM documents;");
  await persistDatabase();
  await window.pdfReader?.semantic.clearDatabase();
  dbPromise = null;
}

export async function downloadSemanticModel(modelId: string, onProgress?: (progress: SemanticIndexProgress) => void) {
  const modelSettings = await window.pdfReader?.semantic.getSettings();
  const settings = modelSettings ?? {
    enabled: true,
    activeModelId: modelId,
    chunkingProfile: "balanced" as const,
    minSemanticScore: defaultSemanticScoreThreshold,
    downloadedModelIds: []
  };
  await getEmbeddingPipeline(modelId, onProgress);
  await window.pdfReader?.semantic.markModelDownloaded(modelId);
  return window.pdfReader?.semantic.saveSettings({
    ...settings,
    activeModelId: settings.activeModelId || modelId,
    downloadedModelIds: [...new Set([...settings.downloadedModelIds, modelId])]
  });
}

async function hashBytes(bytes: Uint8Array) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

async function extractDocumentText(pdfDoc: PDFDocumentProxy, ocrPages: OcrPageText[], onProgress?: (progress: SemanticIndexProgress) => void) {
  const ocrTextByPage = new Map(ocrPages.map((page) => [page.page, page.text]));
  const pages: PageText[] = [];

  for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
    onProgress?.({
      status: "checking",
      current: pageNumber,
      total: pdfDoc.numPages,
      message: `Reading page ${pageNumber} of ${pdfDoc.numPages}`
    });
    const page = await pdfDoc.getPage(pageNumber);
    const nativeText = normalizeText(await extractPageText(page));
    const ocrText = normalizeText(ocrTextByPage.get(pageNumber) ?? "");
    const useOcrText = nativeText.replace(/\s/g, "").length < 100 && ocrText.length > 0;
    pages.push({
      page: pageNumber,
      text: useOcrText ? ocrText : nativeText,
      source: useOcrText ? "ocr" : "pdf"
    });
  }

  return pages.filter((page) => page.text.length > 0);
}

function chunkPageText(hash: string, pages: PageText[], profile: SemanticSearchSettings["chunkingProfile"]) {
  const preset = getChunkingPreset(profile);
  const chunks: TextChunk[] = [];

  for (const page of pages) {
    const words = page.text.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const step = Math.max(1, preset.chunkTokens - preset.overlapTokens);
    let chunkIndex = 0;

    for (let start = 0; start < words.length; start += step) {
      const text = words.slice(start, start + preset.chunkTokens).join(" ");
      if (text.length < 20) continue;
      chunks.push({
        id: `${hash}:${profile}:${semanticChunkingVersion}:${page.page}:${chunkIndex}`,
        page: page.page,
        index: chunkIndex,
        text
      });
      chunkIndex += 1;
      if (start + preset.chunkTokens >= words.length) break;
    }
  }

  return chunks;
}

async function getEmbeddingPipeline(modelId: string, onProgress?: (progress: SemanticIndexProgress) => void) {
  if (!pipelinePromises.has(modelId)) {
    pipelinePromises.set(
      modelId,
      pipeline("feature-extraction", modelId, {
        dtype: "q8",
        progress_callback: (event: any) => {
          if (event?.status === "progress" && typeof event.loaded === "number" && typeof event.total === "number") {
            onProgress?.({
              status: "downloading",
              current: event.loaded,
              total: event.total,
              message: "Downloading embedding model"
            });
          }
        }
      } as any).catch((error) => {
        pipelinePromises.delete(modelId);
        throw error;
      })
    );
  }

  return pipelinePromises.get(modelId)!;
}

async function embedText(text: string, settings: SemanticSearchSettings, mode: "query" | "passage", onProgress?: (progress: SemanticIndexProgress) => void) {
  const model = getCuratedEmbeddingModel(settings.activeModelId);
  const extractor = await getEmbeddingPipeline(model.id, onProgress);
  const input = mode === "query" && model.queryPrefix ? `${model.queryPrefix}${text}` : text;
  const output = await extractor(input, { pooling: "mean", normalize: true });
  return Float32Array.from(output.data as Float32Array);
}

function vectorToBlob(vector: Float32Array) {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

function blobToVector(blob: Uint8Array) {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

function cosineSimilarity(left: Float32Array, right: Float32Array) {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }

  if (!leftMagnitude || !rightMagnitude) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function documentHasCompleteIndex(db: Database, documentId: number, chunkCount: number, settings: SemanticSearchSettings) {
  const model = getCuratedEmbeddingModel(settings.activeModelId);
  const result = db.exec(
    `SELECT COUNT(*) AS count
     FROM chunk_embeddings embedding
     JOIN document_chunks chunk ON chunk.id = embedding.chunk_id
     WHERE chunk.document_id = ?
       AND chunk.chunking_profile = ?
       AND chunk.chunking_version = ?
       AND embedding.model_id = ?
       AND embedding.model_version = ?
       AND embedding.dimensions = ?`,
    [documentId, settings.chunkingProfile, semanticChunkingVersion, model.id, modelVersion, model.dimensions]
  );
  const count = Number(result[0]?.values[0]?.[0] ?? 0);
  return count >= chunkCount && chunkCount > 0;
}

function upsertDocument(
  db: Database,
  hash: string,
  input: DocumentIndexInput,
  pageCount: number,
  textSource: "pdf" | "ocr" | "mixed"
) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO documents (
      content_hash, name, file_path, file_size, page_count, text_source,
      text_extraction_version, ocr_extraction_version, created_at, last_opened_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(content_hash) DO UPDATE SET
      name = excluded.name,
      file_path = excluded.file_path,
      file_size = excluded.file_size,
      page_count = excluded.page_count,
      text_source = excluded.text_source,
      text_extraction_version = excluded.text_extraction_version,
      ocr_extraction_version = excluded.ocr_extraction_version,
      last_opened_at = excluded.last_opened_at`,
    [
      hash,
      input.name,
      input.path ?? null,
      input.bytes.byteLength,
      pageCount,
      textSource,
      textExtractionVersion,
      ocrExtractionVersion,
      now,
      now
    ]
  );

  const result = db.exec("SELECT id FROM documents WHERE content_hash = ?", [hash]);
  return Number(result[0]?.values[0]?.[0]);
}

export async function indexSemanticDocument(input: DocumentIndexInput) {
  if (!input.settings.enabled || !window.pdfReader?.semantic) return;

  const db = await getDatabase();
  const model = getCuratedEmbeddingModel(input.settings.activeModelId);
  const hash = await hashBytes(input.bytes);
  if (input.isCancelled?.()) return;

  input.onProgress?.({ status: "checking", message: "Checking semantic index" });
  const pages = await extractDocumentText(input.pdfDoc, input.ocrPages, input.onProgress);
  if (input.isCancelled?.()) return;
  const textSource = pages.some((page) => page.source === "ocr")
    ? pages.every((page) => page.source === "ocr")
      ? "ocr"
      : "mixed"
    : "pdf";
  const chunks = chunkPageText(hash, pages, input.settings.chunkingProfile);
  const documentId = upsertDocument(db, hash, input, input.pdfDoc.numPages, textSource);

  if (chunks.length === 0) {
    input.onProgress?.({ status: "ready", message: "No text to index" });
    await persistDatabase();
    return;
  }

  if (documentHasCompleteIndex(db, documentId, chunks.length, input.settings)) {
    input.onProgress?.({ status: "ready", current: chunks.length, total: chunks.length, message: "Semantic index ready" });
    return;
  }

  db.run(
    `DELETE FROM chunk_embeddings
     WHERE chunk_id IN (
       SELECT id FROM document_chunks
       WHERE document_id = ? AND chunking_profile = ? AND chunking_version = ?
     )
     AND model_id = ? AND model_version = ?`,
    [documentId, input.settings.chunkingProfile, semanticChunkingVersion, model.id, modelVersion]
  );
  db.run(
    `DELETE FROM document_chunks
     WHERE document_id = ? AND chunking_profile = ? AND chunking_version = ?`,
    [documentId, input.settings.chunkingProfile, semanticChunkingVersion]
  );

  const insertChunk = db.prepare(
    `INSERT INTO document_chunks (id, document_id, page_number, chunk_index, text, chunking_profile, chunking_version)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertEmbedding = db.prepare(
    `INSERT INTO chunk_embeddings (chunk_id, model_id, model_version, dimensions, vector, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  try {
    for (const [index, chunk] of chunks.entries()) {
      if (input.isCancelled?.()) return;
      input.onProgress?.({
        status: "indexing",
        current: index + 1,
        total: chunks.length,
        message: `Indexing ${index + 1} of ${chunks.length}`
      });
      const vector = await embedText(chunk.text, input.settings, "passage", input.onProgress);
      insertChunk.run([chunk.id, documentId, chunk.page, chunk.index, chunk.text, input.settings.chunkingProfile, semanticChunkingVersion]);
      insertEmbedding.run([chunk.id, model.id, modelVersion, model.dimensions, vectorToBlob(vector), new Date().toISOString()]);
      await yieldToBrowser();
    }
  } finally {
    insertChunk.free();
    insertEmbedding.free();
  }

  await window.pdfReader.semantic.markModelDownloaded(model.id);
  await persistDatabase();
  input.onProgress?.({ status: "ready", current: chunks.length, total: chunks.length, message: "Semantic index ready" });
}

export async function searchSemanticDocument(input: SemanticSearchInput): Promise<SemanticSearchResult[]> {
  if (!input.settings.enabled || !input.query.trim() || !window.pdfReader?.semantic) return [];
  const db = await getDatabase();
  const hash = await hashBytes(input.bytes);
  const model = getCuratedEmbeddingModel(input.settings.activeModelId);
  const documentResult = db.exec("SELECT id FROM documents WHERE content_hash = ?", [hash]);
  const documentId = Number(documentResult[0]?.values[0]?.[0] ?? 0);
  if (!documentId) return [];

  const queryVector = await embedText(input.query.trim(), input.settings, "query");
  const result = db.exec(
    `SELECT chunk.id, chunk.page_number, chunk.text, embedding.vector
     FROM chunk_embeddings embedding
     JOIN document_chunks chunk ON chunk.id = embedding.chunk_id
     WHERE chunk.document_id = ?
       AND chunk.chunking_profile = ?
       AND chunk.chunking_version = ?
       AND embedding.model_id = ?
       AND embedding.model_version = ?
       AND embedding.dimensions = ?`,
    [documentId, input.settings.chunkingProfile, semanticChunkingVersion, model.id, modelVersion, model.dimensions]
  );

  const rows = result[0]?.values ?? [];
  const minScore =
    typeof input.settings.minSemanticScore === "number" && Number.isFinite(input.settings.minSemanticScore)
      ? input.settings.minSemanticScore
      : defaultSemanticScoreThreshold;
  return rows
    .map((row) => {
      const vectorBlob = row[3];
      const vector = vectorBlob instanceof Uint8Array ? blobToVector(vectorBlob) : new Float32Array();
      return {
        id: String(row[0]),
        page: Number(row[1]),
        snippet: createSnippet(String(row[2])),
        score: cosineSimilarity(queryVector, vector)
      };
    })
    .filter((item) => item.score >= minScore)
    .sort((left, right) => right.score - left.score)
    .slice(0, 12)
    .sort((left, right) => left.page - right.page || right.score - left.score);
}

function createSnippet(text: string) {
  const normalized = normalizeText(text);
  return normalized.length > 260 ? `${normalized.slice(0, 257)}...` : normalized;
}
