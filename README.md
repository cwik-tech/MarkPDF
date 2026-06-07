# MarkPDF

An open-source, minimalistic, standalone PDF and Markdown reader that puts the features usually locked behind paywalls (editing PDFs, annotating, and signing) — into a free, local-first desktop app with advanced AI features.

![MarkPDF reading a PDF](docs/screenshots/app-window.png)

## Features

On top of typical pdf reader features (view, rotate, zoom etc.) the app contains the following capabilities:

### Cleanup

- The app is minimalistic by design and thus majority of junk present in your standard PDF reader is gone

### AI 

- Autodetection of all your CLI agents
- Connect any LLM provider (remote or local)
- Semantic search in your file (type keyward and press enter to see the results)


![AI Providers settings](docs/screenshots/ai-providers-settings.png)

![Semantic Search settings](docs/screenshots/semantic-search-settings.png)


### Typically behind paywall features
- OCR conversion
- Group of images to PDF conversion
- Edit PDF (for now just page ordering)

### Viewing
- Light and dark themes with a theme switcher; defaults to the OS theme on first launch and remembers your choice.

### Editing & Annotation
- Add, move, resize, edit, and delete text overlays (with font-size control).
- Highlight selected text.
- Add pinned comments from selected text; edit and delete them.
- Comments and highlights are saved as standard PDF annotations, viewable in other Acrobat-compatible readers.

### Forms
- Detect fillable PDF form fields.
- Fill text fields, checkboxes, radio groups, and dropdowns.
- Form values are preserved in saved and exported PDFs.

### Signing
- Draw a signature with mouse/trackpad, type it as text, or upload a signature image.
- Place, move, and resize visual signatures on the page.

> Note: signatures are *visual* only — MarkPDF does not provide certificate-backed digital signatures, identity verification, or legal/compliance guarantees yet.



## Vision

I am at the very early stage of what this app should be, but so far I see it as:

1. Free, open-source alternative to paid alternatives
3. PDF/Markdown viewer with advanced AI features for humans and AI agents.
3. Minimalistic design
4. Extensible with community plugins (just like Obsidian is)
5. Not a "chat with pdf" app - you have your favorite chatbot for that (though possible via plugins in future - see below)

## Roadmap & Ideas

Looking for people who want to contribute to codebase and bring it to next level. Thus far, these are my ideas:

1. Plugin interface - to enable community building easily on top of the core (just like in Obsidian)
2. Signature interface - Bring Your Own Key (BYOK) for any signature provider - to remove vendor lock-in like the one in traditial PDF reader 
3. Expose as MCP/CLI (plus a Skill.md) for pdf-to-markdown and image-to-pdf conversions - to have a fixed realiable tool for this task
4. Discussion interface for AI agents - read your PDF and discuss with multiple AI agents
5. Obsidian plugin - read and discuss with agents in MarkPDF, save conclusions in Obsidian/MD file.
6. Make semantic search state-of-the-art - I just did the basic one, good but not great
6. Make OCR state of the art - handling images is missing

and anything else you think we should implement to make it awesome.

## Tech Stack

- **TypeScript** + **React 19** for the UI.
- **Electron** for the desktop shell.
- **PDF.js** (`pdfjs-dist`) for rendering.
- **pdf-lib** for editing, annotations, forms, and export.
- **Vite** for bundling, **electron-builder** for packaging.
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
