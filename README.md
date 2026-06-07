# MarkPDF

An open-source, standalone PDF and Markdown reader that puts the features usually locked behind paywalls — editing PDFs, annotating, filling forms, and signing — into a free, local-first desktop app.

![MarkPDF reading a PDF](docs/screenshots/app-window.png)

## What It Is

Reading PDFs is free everywhere. Editing them, signing them, filling forms, and searching across them is where most apps put up a paywall or a subscription. MarkPDF brings those capabilities together in a single open-source desktop app that runs entirely on your machine — there is no server, no account, and your documents never leave your computer.

It opens both PDF and Markdown, handles multiple documents at once through a tabbed interface, and remembers per-document state (page, zoom, view mode, edits, and unsaved changes). On top of the everyday viewer, it adds genuinely useful extras like on-device OCR and AI-powered semantic search, so you can find information by meaning rather than exact keywords — without sending anything to the cloud.

## Features

### Viewing
- Open local PDFs, including password-protected files.
- Multiple PDFs open at once as tabs.
- Drag and drop PDFs to open them in new tabs.
- Recent files menu.
- Single-page, two-page, and continuous-scrolling view modes.
- Page navigation: previous/next, direct page-number input, and total page count.
- Zoom in/out, actual size, fit page, fit width, fit height.
- Rotate the page view.
- Full-screen mode.
- Thumbnail sidebar and bookmarks/outline sidebar.
- Light and dark themes with a theme switcher; defaults to the OS theme on first launch and remembers your choice.
- Keyboard shortcuts for navigation, zoom, find, save, undo/redo, and escape-to-select.

### Editing & Annotation
- Add, move, resize, edit, and delete text overlays (with font-size control).
- Highlight selected text.
- Add pinned comments from selected text; edit and delete them.
- Comments and highlights are saved as standard PDF annotations, viewable in other Acrobat-compatible readers.
- Undo/redo support.

### Forms
- Detect fillable PDF form fields.
- Fill text fields, checkboxes, radio groups, and dropdowns.
- Form values are preserved in saved and exported PDFs.

### Signing
- Draw a signature with mouse/trackpad, type it as text, or upload a signature image.
- Place, move, and resize visual signatures on the page.

> Note: signatures are *visual* only — MarkPDF does not provide certificate-backed digital signatures, identity verification, or legal/compliance guarantees.

### Saving, Exporting & Printing
- Save, save as a new file, and export a flattened PDF.
- Print the current PDF with overlays, form values, and signatures included.
- Unsaved-change prompts when closing a modified tab or quitting.

### Additional Capabilities
- Text search with match navigation.
- OCR and semantic search support.
- Markdown preview and document-to-Markdown conversion.
- Local AI provider settings.

## Tech Stack

- **TypeScript** + **React 19** for the UI.
- **Electron** for the desktop shell.
- **PDF.js** (`pdfjs-dist`) for rendering.
- **pdf-lib** for editing, annotations, forms, and export.
- **Tesseract.js** for on-device OCR of scanned/image-only PDFs.
- **Vite** for bundling, **electron-builder** for packaging.

### Semantic Search (Local Vector Database)

MarkPDF includes a fully on-device semantic search engine — no cloud, no API keys, no data leaving the machine.

- **Embeddings:** generated locally with [Transformers.js](https://github.com/huggingface/transformers.js) running ONNX models in-process. Curated models include **BGE Small EN v1.5** (384-dim), **MiniLM L6 v2** (384-dim), and **BGE Base EN v1.5** (768-dim). Embeddings use mean pooling with L2 normalization.
- **Vector store:** a local **SQLite** database (via `sql.js` / WebAssembly) persisted to the app's user-data directory. Document text is chunked, embedded, and stored as Float32 vector blobs alongside their source page, with deduplication by content hash so re-opening a document doesn't re-index it.
- **Retrieval:** queries are embedded with the same model and ranked by **cosine similarity** against the stored chunk vectors, with a configurable score threshold (loose / balanced / strict) to tune precision vs. recall.
- **Tunable chunking:** precise, balanced, and contextual presets control chunk size and overlap to trade granularity against context.
- **Text extraction:** native PDF text where available, falling back to **Tesseract.js OCR** for scanned pages so even image-only PDFs become searchable.

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Packaging

```bash
npm run package   # unpacked app directory
npm run dist      # distributable installer
```

## License and Rights

MarkPDF source code is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

The MarkPDF name, logo, icons, product identity, and associated branding are **not**
licensed under Apache-2.0. See [NOTICE](NOTICE) and [TRADEMARKS.md](TRADEMARKS.md).

Third-party package notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contributing

Contributions are accepted under Apache-2.0. See [CONTRIBUTING.md](CONTRIBUTING.md).
