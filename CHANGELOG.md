# Changelog

## 0.1.0 - 2026-06-04

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
