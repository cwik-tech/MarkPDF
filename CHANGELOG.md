# Changelog

## [Unreleased]

### Added

- Table-of-contents links in a PDF are now clickable. MarkPDF reads the document's own link annotations and moves to the page each one points at, whether it names that page directly or by a name in the document's catalogue. Links to the web are deliberately left inert for now, and an annotation that is not a link, or whose rectangle is damaged, produces nothing to click.
- The toolbar now says which part of preparing a document is actually running: `Checking text` while the text layer is examined, `Native text detected` for a moment when it turns out no recognition is needed, `OCR 2/4` with a progress bar while pages are read by recognition — in the window or in the main process — and `Index 12/32` only once that is done. Recognition inside the index job used to be reported as "Checking index", which is how the slowest part of preparing a scanned document became invisible.

### Fixed

- Highlighting or commenting on text that spans more than one line now covers only the lines you selected. The blank page between two lines, and the space beside a short last line, stay clear in the window, in a printed or flattened page, and in another PDF reader, where the annotation now carries one quadrilateral per line instead of one box over all of them. Selecting the annotation draws no blue outline or resize square, and its Delete button sits outside the text. A comment made from a selection keeps its pin and its popup, and is exported as markup over that text carrying your note; a comment you drop on the page is still a note pinned to a point. Highlights and comments you place by hand are unchanged, and a document saved by an earlier version opens with its annotations exactly where they were.
- Quitting MarkPDF during OCR now cancels active recognition and exits promptly after any unsaved-document confirmation instead of leaving the macOS process running behind a closed window.
- Large PDFs now render their first page before OCR and optional metadata work begins, and raw PDF bytes no longer pass through rendered React props where development diagnostics enumerated millions of byte entries and froze the window.
- Reopening an unchanged document that is already indexed no longer re-reads it: nothing is parsed, rasterised, recognised or embedded, and the embedding model is not loaded. A scanned book used to be recognised in full on every open. Anything that does not match — different bytes, a changed setting, a page nothing could read, or an interrupted index — is read and indexed as before, and re-indexing on purpose still rebuilds from scratch.
- The OCR counter in the toolbar counts the pages being recognised rather than the pages of the document, so a 628-page book with 59 pages to read shows `OCR 42/59` instead of `OCR 437/628`. The page being read stays in the progress message, which the toolbar shows as the badge's tooltip and the Semantic Search panel shows while the index is being prepared.
- A document whose indexing was interrupted no longer records a newer reading of itself than the text it has actually cached, so the next open re-reads it instead of trusting a stale cache.
- Indexing the same document from the app and the `markpdf` command at the same time can no longer leave a half-of-each index recorded as complete. Whichever run finishes second finds the index no longer matches what it wrote, reports that it could not finish rather than claiming success, and the next open rebuilds the document.
- A document indexed by an earlier version of MarkPDF is brought up to date by the first open that reads it, instead of being read in full on every open. A document that now reads as empty also stops serving the passages of its previous reading, unless the emptiness is only a page nothing could read.
- Selecting PDF text no longer paints selection bars for invisible line breaks at the left edge of the page.
- Searching a tagged PDF now highlights the word you searched for. Highlights in documents with tagged structure — most large published books — collapsed on to the top-left corner of the page, and the view did not move to the match because it thought the marker was already on screen. Highlights are now measured from the browser's own text rectangles, so they sit over the glyphs at any zoom and after rotating the page, and partial matches inside a long line are no longer estimated from the line's width.

- Long MCP calls now report bounded, monotonic progress to clients that request it, including the page currently being read by OCR and embedding-model download bytes.
- MCP can now report the visible page of every open PDF and read the loaded contents of every open Markdown tab without revealing a file path. Long notes paginate by offset, and private snapshots follow the tab lifetime.
- MCP document replies now say whether their text is an index snapshot and, when it is, when that exact page cache or search scope was recorded. Search scopes are timestamped independently, so changing the chunking profile or embedding model cannot make an older scope claim the newer scope's time.
- A picture on a page that reads perfectly well is no longer invisible to search. MarkPDF now finds sizeable images on text pages, reads just that part of the page, and adds what it finds to the page's own words — so a figure containing a number or a table row is retrievable whether it sits on a scanned page or beside ordinary text. Pages with only small decorations are left alone, and nothing is rendered or recognised unless a picture actually qualifies.
- An assistant connected through MCP now works under the settings the application is actually using, as they change. Change the embedding model or the similarity threshold in MarkPDF and the next MCP answer already honours it — no editor restart, no reconnecting the assistant. The command line and the MCP tool also agree passage for passage when asked the same question of the same index, and `min_score` falls back to the application's own threshold on both surfaces unless the caller gives one explicitly.
- Search results now say where each heading comes from. An assistant gets the heading's page with the heading itself, and a flag for whether the passage sits under that heading or merely follows it from a later page — so a passage no longer appears to claim a heading that closed the page before it. Results indexed before this change report their headings without pages until they are re-indexed, which happens on its own.
- Slide labels like `**T R A C T I O N**` no longer compete with content in search. A short label in front of content on the same page is indexed as context for that content instead of as a passage of its own, and a label that ends a page is still retrievable. Repeated page furniture — the footer that appears on every page — no longer takes up retrieval slots at all. The document's text is unchanged everywhere; only what search retrieves is.
- `markpdf mcp` starts the MCP server through the installed command, so registering MarkPDF with an MCP client is one line — `claude mcp add markpdf -- markpdf mcp` — instead of a path into the application bundle. Settings › CLI & MCP shows this command and the equivalent JSON configuration with copy buttons.

- MarkPDF now speaks the Model Context Protocol, so an assistant that supports MCP can read your documents directly. Four tools: show a document's heading structure, search one by meaning, read specific pages, and convert one to Markdown. It is the same index, the same extractor and the same permissions the app and the `markpdf` command use — an assistant is another way in, not another set of rules. Register it once with your client; see the MCP Server section of the README.
- No MCP tool indexes, grants or forgets anything. Permission is still given at a terminal, where a person is present, and an assistant cannot widen its own access. Searching and reading pages of a document you have already indexed need no file permission at all, so an assistant can work through a library whose folder you have taken back.
- Every MCP reply is bounded and says so. A document longer than one answer can carry comes back with the amount that was left out, rather than shortened in a way that reads as complete. There are two limits: how much document text is gathered, and how much finished text is handed back — the second is measured on the reply itself, because what JSON costs depends on what is in it.
- A `markpdf` command you can run from a terminal, or hand to an AI agent. It indexes documents, searches one by meaning, shows a document's heading structure, and converts a PDF to Markdown. Results go to standard output — as JSON with `--json` — and progress goes to standard error, so the output can be piped into something that reads it. Install it from Settings › General.
- The command asks before it reads anything. Nothing on your disk is readable until you grant a folder, either by answering a one-key prompt or by running the command the refusal prints. Granting a folder to read does not grant permission to write into it. You can withdraw a grant at any time, and withdrawing a folder also withdraws everything inside it.
- Searching a document you have already indexed needs no file permission at all: the answer comes from the index, and the file is never opened. So you can index a library, take the grant away, and still search it.
- `markpdf convert --pages 3-7` reads only those pages. On a scanned document it recognises only the pages you asked for, so pulling one page out of a long scan does not cost a pass over the whole thing.
- Scanned pages can now be read outside the app window. Given a PDF that is only images, the command renders each unreadable page and reads the text off it, entirely offline — nothing is downloaded, and nothing is written into whatever folder you happened to run it from. Indexing, outlining and converting all read a document the same way, so a scanned page is not readable through one of them and blank through another.
- Removing a document from the index now removes its text from the file on disk, not just its rows. The space it occupied is reclaimed and overwritten, so the words cannot be read back out of the database file afterwards. Clearing the whole index does the same. If another window or another process is using the index at that moment the reclaim cannot run, so the removal is refused outright and nothing is deleted — you are told to try again rather than told it worked while the text is still there.
- Semantic indexing, embedding and search now run in a pure-Node `core/` layer inside the main process, reachable from the renderer through the preload bridge. This is the groundwork for driving MarkPDF from a terminal.
- The semantic index is a real SQLite database managed with `better-sqlite3` and write-ahead logging, so a second process can read and write the file safely while the app is open. Coordinating two processes indexing the same document is separate work and is not part of this change.
- Documents are now read by a native PDF extractor that preserves structure, so a table stays a table. A search result can quote a whole table row and tell you which page and which section it came from, instead of returning loose words with no context.
- Search results carry the heading a passage sits under, including when that heading is on the previous page.
- The extracted text of each document is now kept alongside the index, page by page. `markpdf outline` reads it back, which is why showing the structure of a document you have already indexed needs no file permission; indexing itself still re-reads the document each time.

### Changed

- CLI & MCP setup guidance now sits behind compact shadcn info tooltips instead of permanent subheadings and paragraphs.
- OCR now rasterises and recognises one page at a time, allows only one recognition job at once, and removes cancelled work from the queue immediately; cheap index-only MCP calls remain responsive while a scan is being read.
- The Command Line section moved from Settings › General to its own Settings › CLI & MCP page, alongside the new MCP Server instructions.

- Settings › General gained a Command Line section that says what the `markpdf` command on your machine is: not installed, installed and current, out of date, pointing at a different copy of MarkPDF, or shadowed by another program of the same name. Installation now puts the user-local directory on the active shell's PATH when needed.
- The index file records what became of each page of a document, alongside the page's text. It is upgraded in place and nothing is re-indexed; a copy of the index written by this version cannot be opened by an older one, which is refused outright rather than misread.
- The index file is upgraded in place on first launch, preserving every document and chunk already stored. Passages are then re-split as each document is opened, because how text is divided has changed. Nothing is lost and no action is needed.
- Reading a document now happens in the main process rather than in the window, using the native extractor. Embedding, chunking and index writes moved there too, and progress is reported back to the window. Long stretches of that work are still measurable, so this reduces interface stalls rather than eliminating them.
- Foreign key enforcement is now on, so removing a document genuinely removes its chunks and embeddings rather than leaving them behind.
- Embedding model weights are cached on disk under the application data directory instead of in the browser cache. Existing users download the model once more; afterwards the same copy serves every process.
- Semantic search no longer fetches anything from the network to work: the embedding runtime is bundled, and so are the small files used to measure how long a passage is.
- Two windows holding the same document can no longer index it at the same time. Previously the second run collided with the first on duplicate chunk identifiers and failed.
- Opening many documents at once now indexes them one at a time. Embedding cannot run in parallel anyway, so overlapping the jobs only used more memory and made the application less responsive.
- Cancelling an index — by closing a tab, changing a setting, or turning semantic search off — stops a document that is still waiting its turn before it reads the file or loads the model, and stops one already being read at the next point the extractor returns. The extractor itself cannot be interrupted mid-read, so a cancel there costs one wasted read and never a written row.
- Scanned pages are decided by the extractor rather than by counting characters. Text this window has already scanned is offered to it as a candidate and used for the pages it reports as unreadable; the progress line says how many candidates were used.
- The embedding model's download progress now reaches whoever is watching. Previously only the first request to trigger a download saw the percentage, so opening the settings dialog partway through showed a bar that never moved.
- A model is recorded as downloaded only after either a successful load — an explicit download finishing — or indexing that actually embedded document text, and in both cases only once its files are confirmed on disk. If the model cache is cleared or the data directory moves, the application notices and offers the download again instead of claiming the model is ready.

### Fixed

- MCP client setup snippets now use MarkPDF's absolute installed command path instead of relying on the client's `PATH` to resolve `markpdf`.
- Markdown documents once again open as a single read-only preview. MCP can still read the open document without adding an editor, Markdown Save behavior, or a second scrollbar.
- `to_markdown` now verifies the current file contents before using cached text, so replacing a PDF at the same path returns the new document even when the replacement has exactly the same byte length. Index-only tools continue to expose the older indexed snapshot until the file is re-indexed, and identify it as such.
- Scanned financial tables now keep their rows and columns when they enter the index. Reading the pictured page through an assistant returns a Markdown table, and semantic search can associate a value with the correct row and year instead of seeing a loose sequence of numbers.
- A page that is only a picture is no longer skipped when the app indexes a document. MarkPDF decided whether to read a scan by sampling five pages — the first three, the middle and the last — so a scanned table in an otherwise ordinary report was stored as an empty page, and searching for anything on it found nothing. Every page a document's structure cannot be read from is now read, whichever way the document was opened.
- A page nothing could read is no longer counted as a blank page. MarkPDF now records why each page is empty — because there was nothing on it, or because nothing managed to read it — so a document with a gap is reported as incomplete rather than ready, the tab names the pages that could not be read, and an assistant reading those pages is told they are missing instead of being handed an empty page. Documents indexed before this change repair themselves the next time they are opened.
- Scanned pages are read the same way in the app as at the command line. The app used to index its own on-screen reading of a scan, which was produced for displaying selectable text and flattened tables into a loose run of numbers; the same file therefore indexed differently depending on which one had opened it. On-screen text selection, in-window search and Markdown conversion are unchanged and still use the app's own reading.

- Command Line status no longer stays on “Checking...” when an interactive zsh plugin requires a real terminal; the PATH probe now uses a bounded pseudo-terminal and cleans up the whole shell process group on timeout.
- Installing the `markpdf` command now completes user-local PATH setup itself, opens a fresh Terminal when the shell profile changed, turns the status green, removes the obsolete copy-paste instruction, and shows a completion toast.
- Large tables are no longer lost past their first rows. Text handed to the embedding model was silently cut at the model's limit, and a long table exceeded it many times over — measured on a 400-row table, 287 rows reached the model and 113 did not. Every row is now reachable. A table too long for one passage is split between whole rows wherever it can be, and where a single row or cell is itself too long it is carried across passages in consecutive parts, keeping every character.
- Render Mermaid fenced blocks as theme-aware SVG charts in Markdown previews instead of displaying their source code.

### Removed

- The `sql.js` WebAssembly database. It could only rewrite the whole index file at once, which made it impossible to share the index with another process.
- Intel macOS support. MarkPDF now requires an Apple Silicon Mac, and existing Intel Macs stop receiving updates at the last release that shipped an `x64` build. The semantic index is now a native SQLite database, and the release no longer carries an Intel build of it; shipping the Intel app without it would produce a download that fails on launch rather than one that merely lacks a feature.

## 2026-06-07 17:40

- Fixed Markdown image-description export so copied image assets are referenced instead of Docling temp paths, bad fragment descriptions are skipped, and description ordering stays aligned with exported images.

## 2026-06-07 17:28

- Added a default-on Markdown export option to describe images and insert the generated descriptions below exported image links.

## 2026-06-07 17:06

- Fixed Markdown preview image loading by resolving relative image and link URLs against the opened Markdown file's folder.

## 2026-06-07 16:58

- Kept Docling page-marker insertion out of Markdown tables so exported table and table-of-contents blocks are not split by generated page anchors.

## 2026-06-07 16:05

- Migrated legacy Markdown export settings so the previous hidden Docling-standard default opens as Auto, while preserving manual engine selection after the user changes it.
- Replaced electron-builder's hidden macOS notarization call with a custom after-sign notarization hook that disables S3 acceleration, adds hard timeouts, staples the accepted ticket, and prints visible notarytool output in CI.
- Added a timeout to the GitHub Actions macOS release build step so notarization cannot hang indefinitely.
- Moved the macOS signing identity name into the `MAC_CSC_NAME` GitHub Actions secret so it is not hardcoded in the public workflow.
- Documented the `MAC_CSC_NAME` value format expected by electron-builder.
- Excluded non-mac `onnxruntime-node` native binaries from packaged macOS builds and extended the Apple notarization wait window for large release archives.

## 2026-06-07 14:24

- Added Markdown table parsing, rendering, alignment support, and scroll-safe table styling for Markdown preview tabs.
- Made Docling Markdown export explicitly use table extraction with accurate table mode and preserve referenced PDF image assets beside the saved Markdown file.
- Added Auto as the default Markdown export engine, with modular document profiling that selects standard Docling for healthy text-layer PDFs and SmolDocling VLM for weak-text visual PDFs while keeping basic text extraction as the fallback.

## 2026-06-07 13:51

- Updated the macOS release workflow to import the Developer ID certificate into a temporary CI keychain with explicit codesign access before electron-builder packaging.
- Moved the temporary keychain path export into the workflow shell step so GitHub Actions validates the release workflow before tag-triggered builds.

## 2026-06-07 13:22

- Ignored local Apple certificate request, certificate, private key, and signing identity files to prevent accidental commits of release credentials.

## 2026-06-07 12:31

- Changed the Electron bundle identifier to `tech.cwik.markpdf` before public macOS distribution.
- Added architecture-specific macOS DMG/ZIP release targets, GitHub Release publishing metadata, and stable `MarkPDF-mac-arm64.dmg` and `MarkPDF-mac-x64.dmg` asset names.
- Added a tag-triggered GitHub Actions workflow that builds native Apple Silicon and Intel release assets and requires macOS signing/notarization secrets before publishing.
- Documented the GitHub Releases download URLs and release publishing steps in the README.

## 2026-06-07 01:00

- Added Apache-2.0 repository licensing, NOTICE attribution, trademark policy, third-party notices, and contribution terms for open-source release preparation.
- Updated package metadata and README licensing sections to identify the code license and separate MarkPDF branding rights.

## 0.1.0 - 2026-06-04

- Fixed stale recent-file menus by broadcasting recent-list updates to every open window.
- Fixed large PDF Open With/read failures by sending typed byte arrays over Electron IPC instead of expanded number arrays.
- Fixed macOS cold-start Open With launches by seeding pending files from process arguments before the single-instance lock.
- Fixed macOS Finder/Open With handoff by capturing and draining file-open events in a lightweight Electron bootstrap before the main process modules load.
- Renamed the app identity, package metadata, window title, and user-facing branding to MarkPDF while preserving legacy saved settings and annotation metadata.
- Kept the macOS bundle identifier stable across the MarkPDF rename so existing Finder Markdown/PDF file associations hand files to the running app instead of launching a second app.
- Fixed search navigation so debounced text search no longer re-runs after page changes, Semantic Search result clicks, or Next/Previous match navigation.
- Fixed double-click Markdown/PDF opening by queueing Finder file-open events until the renderer file listeners are ready.
- Improved Docling Markdown page placement by matching normalized token windows instead of one exact PDF text snippet.
- Fixed Docling Markdown page markers so unmatched pages are appended instead of being silently dropped.
- Fixed Finder/Open With launches so PDFs and Markdown files open as tabs in the running app instead of spawning another window.
- Added explicit macOS document UTIs so Finder recommends the app for Markdown and PDF default-open selection.
- Added Docling Markdown post-processing with stable page anchors, app annotation export, and clearer scanned/low-confidence page warnings.
- Added a read-only Markdown settings summary showing the default conversion engine and fallback engine.
- Hid internal Markdown converter controls, normalized the managed converter as the hidden default, and made Save as Markdown fall back to basic extraction when converter setup or conversion fails.
- Fixed Docling Markdown export to read Docling's generated Markdown file, avoid silent built-in fallback, and hide engine-specific save progress text.
- Added Docling auto-install on app startup, visible Docling install progress in Markdown settings, and restored idle search collapse after previous searches.
- Added read-only Markdown preview tabs, Markdown file opening from dialog/drop/Finder handoff, and packaged `.md`/`.markdown` file association support alongside PDFs.
- Added optional app-managed Docling Markdown conversion with engine availability detection, settings-based installation, and fallback to the built-in exporter.
- Added Save as Markdown with a dedicated document-conversion layer, Markdown export settings, OCR fallback, annotation inclusion, and save progress feedback.
- Added Semantic Search score display and configurable relevance cutoff presets, with Balanced defaulting to a stricter 0.30 minimum score.
- Fixed scrolling view activation so semantic navigation scrolls only the document pane, and sorted Semantic Search results by page order.
- Fixed single-page document overflow after adding the resizable Semantic Search sidebar and restored semantic result page jumps in scrolling view.
- Fixed Semantic Search resizing by using percentage panel sizes, preventing workspace overflow, and reducing the resize handle to a thin hover-highlighted separator.
- Widened the Semantic Search sidebar to 25% by default, made it resizable up to half the window, added temporary blue result highlighting on the PDF, closed the sidebar when search clears, and simplified Semantic Search settings layout.
- Fixed submitted semantic search so Enter opens the right sidebar reliably, delayed automatic indexing after model readiness, and yielded between embedding chunks to reduce UI freezes during scrolling.
- Fixed Semantic Search startup download by switching curated defaults to Transformers.js-compatible `Xenova/*` ONNX models, hiding startup download errors from the no-document toolbar, and removing the icon from the semantic status chip.
- Changed Semantic Search to auto-download the recommended model at app startup, use the search lens icon, show model download progress in the toolbar status chip, and open the semantic sidebar from submitted search instead of a standalone sidebar button.
- Added local semantic search with curated embedding models, SQLite-backed document indexing, right-sidebar semantic results, automatic text/OCR indexing, and Semantic Search settings.
- Replaced inline AI status messages with dismissible auto-closing toasts, simplified provider creation to one Add action, and allowed settings to close from the backdrop.
- Fixed top-bar dropdown hover retention, delayed idle search collapse, and changed Open to a titled folder icon button.
- Added progress dialogs for large image imports and PDF saves, with a minimum visible duration for save feedback.
- Disabled the left sidebar when no PDF is open and stopped the Pages panel from showing recent documents in the empty-document state.
- Added an AI Providers settings page with provider persistence, local server presets, model validation, model enablement, CLI agent detection, toolbar settings access, and reserved search/chat shortcuts.
- Fixed non-scrolling page views so mouse wheel input changes pages instead of nudging within the current page.
- Changed the typed signature preview to stack signature and initials vertically and removed the date preview.
- Added image-to-PDF import for Finder/Open With, file dialog, and drag/drop image batches, with generated PDFs opened as unsaved tabs.
- Added drag-and-drop page reordering in the Pages sidebar.
- Rebuilt visual signing with saved typed signatures, generated initials and date stamps, image upload, large drawing modal, Acrobat-style placement, and editable-vs-flattened save prompts.
- Fixed signature placement from saved items, switched all typed signature choices to written-style fonts, persisted editable signatures, and saved flattened signed copies with a ` - signed.pdf` suffix.
- Added conditional automatic OCR for mostly textless PDFs, with toolbar progress and OCR-backed search/text-selection fallback.
- Created the Electron, React, and TypeScript desktop app scaffold.
- Added tabbed PDF opening from dialog, drag and drop, and OS file-open handoff.
- Added PDF rendering with page navigation, zoom, rotate, fit controls, view modes, and scrolling mode.
- Added Zed-inspired dark theme, light theme, and persistent theme toggle.
- Added lightweight text, comment, highlight, and visual signature overlays.
- Added basic form-field detection and filling panel.
- Added PDF save, save-as, flattened export, and print flows.
- Removed the duplicate native-looking header by hiding the macOS title bar and removing the fake traffic-light strip.
- Added persisted recent files with an Open Recent menu and empty-state recent list.
- Replaced numeric page tiles with rendered PDF page thumbnails.
- Added document text search with match navigation and keyboard submit behavior.
- Added a temporary active-match highlight for document search navigation.
- Fixed active search highlighting for words split across PDF text spans and added a clear-search button.
- Fixed search box focus retention, active-match scrolling, and highlight alignment.
- Added debounced live search updates once the query reaches three characters.
- Added keyboard shortcuts for page navigation, zoom, actual size, find focus, and escape-to-select.
- Added standard PDF text-note annotations when exporting comment overlays.
- Reduced the upper app bar height and made the left sidebar closed by default.
- Hardened PDF rendering with bundled PDF.js CMaps, standard fonts, wasm assets, the legacy PDF.js build, visible render errors, and single-page rendering by default.
- Added undo/redo history for edits and page operations, plus page insert, delete, and move controls in the Pages panel.
- Added full-screen controls through Electron and guarded window close when tabs have unsaved changes.
- Added password retry for protected PDFs and a bookmarks sidebar from PDF outline data.
- Fixed packaged app startup by emitting relative Vite asset URLs for Electron file loading.
- Refined the PDF toolbar with sidebar-local page/bookmark switching, compact page and zoom controls, icon-only fit/view menus, expanding search, and left-aligned page labels.
- Fixed toolbar hover/search visibility, separated fit/view icons, moved page labels beside pages, removed the unclear forms shortcut, and enabled selectable PDF text in select mode.
- Restored the single-page icon, constrained recent-file menu labels, repaired wheel scrolling, and added selection actions for highlighting or commenting selected PDF text.
- Added auto-copy for selected PDF text, Cmd/Ctrl+S saving, editable persisted highlights/comments, and Acrobat-style pinned comment popups.
- Centered the page/zoom toolbar controls, improved PDF text copy accuracy, auto-minimized comment popups on outside click, and added Save/Discard/Cancel close prompts.
- Tightened PDF text copy overlap detection and balanced the centered toolbar spacing.
- Restored fit/view dropdown hover behavior, hid scrollbar chrome in non-scrolling views, and made empty toolbar/header space draggable.
- Removed comment/highlight from the main toolbar and fixed intermittent toolbar/search clicks caused by draggable chrome.
- Added delayed hover closing for toolbar dropdowns, collapsed search on mouse-out, and restored empty tab-strip window dragging.
- Added macOS and Windows Electron app icons generated from the bundled app icon.
- Made normal PDF saves write comments and highlights as standard Acrobat-compatible PDF annotations while retaining app-editable overlay metadata.
- Forced the macOS Dock icon to use the bundled app icon at runtime.
- Removed the icon's outer white background and enlarged the mark for Dock display.
- Added hover-only controls for removing individual files from the empty-state recent list without deleting the files.
## 2026-06-07 00:22

Updated the Electron preload bridge in `electron/preload.ts` and refined type definitions in `src/global.d.ts` to support changes in the main application logic. Refactored the `src/App.tsx` component with multiple targeted adjustments and updated semantic indexing behavior in `src/semanticIndex.ts`, collectively addressing core application functionality across the IPC layer, type system, and search capabilities.

## 2026-06-07 00:49

Fixed bugs in the Electron bootstrap and main process logic in `electron/bootstrap.ts` and `electron/main.ts` to address issues with file handling and macOS integration. The changes target the app's startup sequence and main process initialization to improve reliability of file operations and system handoff behavior.
## 2026-06-07 10:42

The README was updated with comprehensive documentation for MarkPDF, a cross-platform desktop PDF reader and editor built with Electron, React, TypeScript, and PDF.js. The documentation covers the application's core features including PDF viewing with multiple view modes, annotation and editing capabilities, form filling, visual signatures, text search with OCR support, and local AI provider integration, along with technology stack details and build/development instructions.

## 2026-06-07 10:50

I don't have visibility into what the actual changes were in `README.md` from the JSONL log alone—it only shows that the file was edited twice but not what content was modified. To write an accurate changelog entry, I'd need to either read the file's current state or see a git diff of those changes. Could you share what was updated in the README, or should I check the git history for those commits?

## 2026-06-07 11:22

The most recent commit (8ba327d) at 11:21:51 on 2026-06-07 matches your edit. Here's the changelog paragraph:

Updated the README with AI Providers and Semantic Search settings documentation, adding visual screenshots to illustrate the configuration options for LLM integration and semantic search features. The changes reorganized content in `README.md` to better highlight these features alongside the newly added screenshot assets in the `docs/screenshots/` directory.
## 2026-06-07 18:21

Created a new memory document to track the macOS notarization issue blocking the MarkPDF release CI process, then updated the project memory index to reference it. The memory captures that Apple's notarization service is stuck in progress on the account side, not a code-related problem.

## 2026-06-24

Renamed the PDF-provided bookmark sidebar tab to Outline and added user-created bookmarks from selected PDF text. Bookmarks now appear as page-side pins, list in a dedicated Bookmarks sidebar tab, persist through MarkPDF editable overlay metadata, and are covered by Vitest PDF/Markdown tests plus a Playwright Electron flow. Added test scripts/configuration and verified the production app build.

Widened the left PDF sidebar so the Pages, Outline, and Bookmarks controls and bookmark rows have more room.

Hid the generic selection inspector for bookmark overlays so bookmark selections only appear in the Bookmarks list and page-side pin.

Added synthetic Outline generation for PDFs without embedded outline data. MarkPDF now infers headings from real PDF text layout, labels generated outlines in the sidebar, persists them in MarkPDF PDF metadata on save, reloads persisted generated outlines, and covers extraction/persistence with Vitest plus the Electron Playwright flow.
## 2026-08-23 11:29

Created a planning document for open-document-awareness capabilities in the MCP CLI project (`open-document-awareness-plan.md`). The document outlines the implementation strategy and design considerations for enabling document awareness features within the CLI context.

## 2026-08-23 14:54

Implemented Phase 2 document indexing to track extraction provenance and Markdown caching, allowing the system to detect when extracted text changes between runs even when file bytes remain identical. The changes add extraction version tracking (`textExtractionVersion`, `ocrExtractionVersion`) and optional Markdown caching with engine metadata, enabling documents with variable OCR or parsing output to be properly reindexed rather than incorrectly reused. A comprehensive test suite validates the reuse logic, cache backfilling for legacy documents, page-outcome tracking, and cancellation behavior across these scenarios.
## 2026-08-30 00:01

Implemented PDF native navigation features including text layer search and internal link handling, with comprehensive test coverage at both unit and e2e levels. Created a document preparation module to coordinate PDF processing pipeline steps and added styling for the new navigation capabilities. Recorded the architectural decisions for OCR/index progress phases in an ADR and updated MCP operations to support the new features.
