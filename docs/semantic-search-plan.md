# Semantic Search Plan

## Goal

Add local-only semantic search for the currently open PDF.

The feature should make document search better without adding chat. Users should be able to find ideas, related passages, and conceptually similar text while keeping PDF contents on the machine.

## Product Shape

Semantic search is a document intelligence feature, not a chatbot.

Primary behavior:

- Classic literal search stays in the toolbar.
- Literal matches stay highlighted directly on the PDF.
- Semantic matches appear in a right sidebar.
- Search remains the user's main entry point.
- The right sidebar opens automatically when semantic results are available.
- The sidebar can later also support selected-text actions like find similar.

Initial scope is single-document only. Cross-document search is a later feature.

## Settings Page

Settings sidebar item:

- Semantic Search

Sections:

- Active embedding model.
- Downloaded models.
- Document index.
- Advanced.

Core controls:

- Enable semantic search.
- Active model selector.
- Download recommended model.
- Download/remove curated models.
- Show local index size.
- Clear semantic index.
- Remove downloaded models.

Privacy copy should be direct:

- Runs locally.
- PDF text is not sent to AI providers.
- Search queries are embedded locally with the active embedding model.

## Model Strategy

Use a curated model list. Do not allow arbitrary Hugging Face URLs in the first version.

Reason:

- Models have different dimensions.
- Models need compatible tokenizer files.
- Some require query prompts.
- Some are not easy to run in Electron.
- Some have unsuitable licenses or runtime formats.
- Unsupported models would create unclear failures.

Recommended default:

- `BAAI/bge-small-en-v1.5`

Why:

- Good retrieval quality.
- 384 dimensions.
- About 133 MB.
- Strong balance of quality, speed, and storage.
- Better default than the smallest MiniLM option without jumping to a much larger model.

Curated model list:

- Recommended: `BAAI/bge-small-en-v1.5`
- Faster/smaller later option: `sentence-transformers/all-MiniLM-L6-v2`
- Higher-quality later option: `BAAI/bge-base-en-v1.5`

Only one embedding model is active at a time.

Downloaded models may coexist, but search and indexing use only the active model.

If the user switches the active model, the semantic index must be rebuilt for that model.

## Dimensions

The database should not assume one global vector dimension.

Each model defines its own embedding dimension:

- `all-MiniLM-L6-v2`: 384
- `bge-small-en-v1.5`: 384
- `bge-base-en-v1.5`: 768

Vectors from different models are not comparable, even when dimensions match.

Store model metadata with every embedding:

- model id
- model version
- dimensions
- runtime format
- query prompt behavior if required

## Search Flow

When the user searches:

1. Run classic literal text search immediately.
2. Show literal matches on the PDF using existing yellow highlights.
3. If the current PDF has a semantic index for the active embedding model, embed the search query locally.
4. Use the same active embedding model that produced the document chunk embeddings.
5. Compare the query vector against stored chunk vectors.
6. Show semantic results in the right sidebar.
7. If the semantic index is missing or still indexing, show literal results only and surface indexing progress.

Important rule:

- The query must be embedded with the same model used to embed the document chunks.

## Indexing Flow

Indexing starts automatically when a PDF opens.

Flow:

1. Open PDF.
2. Extract text layer.
3. If OCR is needed, wait for OCR output.
4. Chunk the extracted or OCR-backed text.
5. Embed chunks in the background with the active model.
6. Store vectors in the local semantic index.
7. Reuse the index on future opens when identity and versions match.

Index both:

- normal text-layer PDFs
- OCR-backed PDFs

Indexing should not block reading or literal search.

## Reuse And Reindexing

The app should not re-vectorize unchanged PDFs every time.

Use a stable document identity:

- preferred: content hash of PDF bytes
- helper metadata: file path, file size, modified time

Reuse an existing semantic index only when these match:

- document hash
- active embedding model id
- active embedding model version
- embedding dimensions
- chunking version
- text extraction version
- OCR extraction version if OCR text was used

Reindex when:

- the file content changed
- the active model changed
- the model version changed
- the chunking profile changed
- the chunking algorithm changed
- OCR output changed
- text extraction logic changed materially

## Local Database Shape

Use SQLite for the local app database.

Conceptual tables:

- `documents`
- `embedding_models`
- `document_chunks`
- `chunk_embeddings`
- `index_jobs`

`documents`:

- id
- content hash
- file path
- file size
- modified time
- page count
- indexed text source
- created at
- last opened at

`embedding_models`:

- id
- display name
- provider/source
- local path
- dimensions
- version
- status
- downloaded at

`document_chunks`:

- id
- document id
- page number
- chunk index
- text
- text offsets if available
- chunking profile
- chunking version

`chunk_embeddings`:

- chunk id
- model id
- vector blob
- created at

`index_jobs`:

- document id
- model id
- status
- progress current
- progress total
- error message

## Vector Storage

For the first version, store vectors as binary blobs.

A vector search extension is optional later.

MVP can use brute-force cosine similarity within the current document because the search scope is one PDF.

This keeps packaging simpler.

## UI Status

Show temporary indexing status in the toolbar/status area, similar to OCR.

States:

- checking index
- downloading model
- indexing document
- indexed enough to search
- failed

Progress:

- page count or chunk count
- avoid permanent "indexed" UI in the main toolbar

Users do not need a persistent indexed badge. Search should simply work when available.

Settings should show:

- index size
- downloaded model size
- clear index
- remove downloaded models

## Right Sidebar

The right sidebar replaces the reserved chat affordance.

It should be document-native and search-driven.

Initial sidebar content:

- semantic search results
- page number
- excerpt
- click to jump to page

Later sidebar actions:

- find similar to selected text
- find similar to a highlight
- collect result into marked context
- export selected context
- show definitions or repeated concepts

Do not call this chat.

## Chunking

Default chunking should be page-aware.

Initial default:

- chunk size: balanced
- overlap: balanced
- do not cross page boundaries in MVP

Avoid exposing raw sliders in the first version.

Use advanced presets instead:

- Precise
- Balanced
- Contextual

Preset meaning:

- Precise: smaller chunks, lower overlap, more targeted results, less context.
- Balanced: default search quality and performance.
- Contextual: larger chunks, higher overlap, more context, more storage, possible duplicate-ish results.

Changing the preset requires rebuilding the semantic index.

Store the selected preset and an internal `chunkingVersion`.

## Download Behavior

Default behavior:

- If semantic search is enabled and no model is installed, offer to download the recommended model.
- The first version may auto-download the recommended model after clear user consent.
- Do not silently download a large model without explaining size and local storage use.

Model download UX:

- show model name
- show approximate download size
- show progress
- allow cancel
- validate downloaded files
- mark model as available only after validation

## Advanced Custom Models

Not in MVP.

Possible later support:

- paste Hugging Face repo id
- validate supported format
- detect dimensions
- detect tokenizer compatibility
- detect required query prompt
- store model metadata
- force reindex before use

Avoid arbitrary URLs in MVP.

## MVP Scope

Included:

- Semantic Search settings page.
- Curated model list.
- Recommended default model.
- One active model at a time.
- Local model download.
- Automatic indexing on PDF open.
- Text-layer and OCR-backed indexing.
- SQLite local index.
- Reuse index by document hash and model metadata.
- Literal search on PDF.
- Semantic results in right sidebar.
- Temporary indexing progress indicator.
- Clear semantic index.
- Remove downloaded models.
- Advanced chunking presets.

Excluded:

- Chat UI.
- Cloud embeddings.
- Sending PDF text to AI providers.
- Cross-document search.
- Arbitrary Hugging Face model URLs.
- Vector database server.
- External model server requirement.
- Page-level semantic highlighting.
- Reranking.

## Later Features

- Cross-document semantic search.
- Find similar to selected text.
- Find similar to highlight/comment.
- Context pack export.
- Obsidian export from semantic results.
- Reranker for better result ordering.
- Custom Hugging Face model support.
- Semantic result highlights on PDF pages.
- Per-document index management.

## Open Decisions

- Exact right-sidebar icon.
- Exact model runtime: Transformers.js ONNX first, or another local runtime.
- Exact SQLite package.
- Whether model download requires explicit click or can be triggered by enabling semantic search.
- Whether semantic sidebar opens after typing three characters or only after pressing Enter.
- Whether indexing starts immediately after OCR begins or waits until OCR completes for all pages.

## Recommended First Implementation Order

1. Semantic Search settings page shell.
2. Curated model registry.
3. Model download and validation.
4. SQLite schema and index metadata.
5. Text extraction to page-aware chunks.
6. Background indexing job with progress.
7. Query embedding with active model.
8. Current-document vector search.
9. Right sidebar semantic results.
10. Clear index and remove model controls.
