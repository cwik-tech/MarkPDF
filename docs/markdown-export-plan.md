# Markdown Export Plan

## Goal

Add `Save as Markdown` as a first-class export action while keeping PDF viewing, OCR, semantic search, and AI provider settings cleanly separated.

The architecture should allow the Markdown conversion engine to be replaced without rewriting the save dropdown, settings UI, progress UI, or document state handling.

## Product Behavior

The save dropdown should add:

- `Save as Markdown`

When selected, the app should:

1. Ask for a `.md` output path.
2. Start a visible export progress indicator.
3. Convert the active document using the configured Markdown engine.
4. Write the Markdown file.
5. Show success or a precise failure message.

Markdown export should not mark the PDF tab dirty or replace the active PDF. It is an export action, not a document save action.

## Architecture

Create a dedicated document conversion layer instead of adding conversion logic directly to `App.tsx`, `semanticIndex.ts`, OCR modules, or AI settings.

Proposed renderer-side structure:

```text
src/documentConversion/
  types.ts
  markdown.ts
  exportOptions.ts
  engines/
    docling.ts
    pymupdf4llm.ts
```

Proposed Electron-side structure:

```text
electron/documentConversion.ts
```

The renderer owns UI state and progress display. Electron owns filesystem dialogs, file writing, and local helper execution.

## Core Interfaces

The conversion layer should expose an engine interface similar to:

```ts
interface MarkdownConversionEngine {
  id: string;
  name: string;
  availability(): Promise<EngineAvailability>;
  convert(input: MarkdownConversionInput): Promise<MarkdownConversionResult>;
}
```

The input should include:

- source PDF bytes or source path
- document name
- page count
- OCR pages, when already available
- export settings
- progress callback

The result should include:

- Markdown text
- warnings
- page/source metadata when available
- engine id and version

## Engine Strategy

Start with a clean engine abstraction before committing to one parser deeply.

Recommended first serious engine: **Docling**.

Why:

- It is a broader document conversion framework, not just a PDF text extractor.
- It can support Markdown now and structured document output later.
- It fits future workflows such as JSON export, page-grounded chunks, table extraction, image extraction, and agent handoff.
- It is a better long-term architecture anchor than wiring the app around one narrow parser.

Keep **PyMuPDF4LLM** as a likely second engine or fallback.

Why:

- It is fast and practical.
- It is useful for born-digital PDFs with good text layers.
- It can become the lightweight local option if Docling is too heavy for default use.

Do not wire Marker, MinerU, PaddleOCR-VL, olmOCR, or Chandra first. They should be advanced engines later because they add more model/runtime complexity.

## Settings

Add a settings category named `Markdown`.

Initial settings should be minimal:

- **Default engine**
  - `Docling`
  - later: `PyMuPDF4LLM`, `Marker`, `MinerU`, cloud engines

- **Export mode**
  - `Readable Markdown`
  - `Page-preserving Markdown`

- **Include page markers**
  - Adds `## Page N` or stable anchors.
  - Useful for citations and cross-reference back to the PDF.

- **Use OCR fallback**
  - Uses existing OCR text when the PDF text layer is missing or weak.
  - Should not blindly OCR every document.

- **Include annotations**
  - Exports comments/highlights/signature notes where applicable.
  - Can be added after the base export works.

- **AI cleanup**
  - Off by default.
  - Optional later integration with configured LLM providers.
  - Should preserve page grounding and avoid inventing content.

Avoid adding too many settings in the first implementation. The first version should have a strong default and only expose controls that materially change the output.

## Progress UI

Markdown conversion can be slow, especially with OCR, layout analysis, or AI cleanup.

Add operation progress for:

- checking engine availability
- preparing document
- converting pages
- applying OCR fallback
- optional AI cleanup
- writing Markdown file

The progress UI should reuse the existing operation-progress pattern used by PDF save/export. It should support cancellation later, but cancellation does not need to be part of the first version.

## OCR Relationship

OCR should remain its own subsystem.

Markdown export can consume OCR output when it already exists, but it should not own OCR implementation details.

Rules:

- If native PDF text is good, prefer native text/layout.
- If native text is missing or weak, use existing OCR output.
- If OCR has not run and the document appears textless, the export flow can trigger OCR or ask the engine to handle OCR, depending on engine capability.
- Do not run OCR blindly on every PDF.

## LLM Relationship

LLMs should be optional post-processors, not the base extraction mechanism.

Good LLM uses:

- clean headings
- repair list formatting
- normalize tables
- create readable section structure
- produce frontmatter or summaries later

Risks:

- hallucinated content
- changed wording
- lost page grounding
- privacy concerns for cloud providers
- slower export

The first Markdown export should work without an LLM.

## Implementation Phases

### Phase 1: Architecture and Basic Export

- Add document conversion types and engine registry.
- Add Markdown settings category with minimal defaults.
- Add Electron IPC for `.md` save dialog and Markdown file writing.
- Add `Save as Markdown` to the save dropdown.
- Add operation progress while export runs.
- Implement one local engine path.

### Phase 2: Better Markdown Fidelity

- Add page markers and stable anchors.
- Add annotation export.
- Improve table/list handling through engine options.
- Add warnings for scanned or low-confidence pages.

### Phase 3: Engine Expansion

- Add Docling as the first layout-aware optional engine, installed into an app-managed runtime instead of relying on a global CLI.
- Add PyMuPDF4LLM as a lightweight fallback or alternate engine.
- Add installed-engine detection.
- Add engine availability messages in Markdown settings.
- Add guided install/download state if needed.

### Phase 4: AI Cleanup

- Use configured LLM providers for optional cleanup.
- Process by page or section to preserve grounding.
- Keep raw extraction available for comparison/debugging.
- Add strict prompts that prohibit invented content.

### Phase 5: Advanced Local Models

- Evaluate Marker, MinerU, PaddleOCR-VL, olmOCR, and Chandra.
- Add model/runtime management only after the base conversion layer is stable.
- Keep these as advanced engines, not required for the default export.

## Open Decisions

- Whether Docling should run as a bundled helper, user-installed Python tool, or managed local runtime.
- Whether the app should store converted Markdown history or only write files.
- Whether Markdown export should include images extracted from the PDF.
- Whether annotations should be inline, footnotes, or a separate section.
- Whether page markers should be headings, comments, or HTML anchors.

## Success Criteria

- The save dropdown contains `Save as Markdown`.
- Export produces a `.md` file without modifying the PDF tab.
- The app shows progress during conversion.
- The conversion engine is replaceable through a narrow interface.
- Markdown settings are isolated from AI provider and semantic search settings.
- OCR is reused through a clean boundary instead of duplicated.
- Future engines can be added without rewriting the UI flow.
