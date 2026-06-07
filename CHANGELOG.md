# Changelog

## 2026-06-07 16:05

- Replaced electron-builder's hidden macOS notarization call with a custom after-sign notarization hook that disables S3 acceleration, adds hard timeouts, staples the accepted ticket, and prints visible notarytool output in CI.
- Added a timeout to the GitHub Actions macOS release build step so notarization cannot hang indefinitely.
- Moved the macOS signing identity name into the `MAC_CSC_NAME` GitHub Actions secret so it is not hardcoded in the public workflow.
- Documented the `MAC_CSC_NAME` value format expected by electron-builder.

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
