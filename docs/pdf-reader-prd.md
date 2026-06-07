# MarkPDF Desktop App PRD

## Goal

Build a standalone desktop PDF reader with core viewing controls, lightweight editing, comments/annotations, printing, form filling, and visual signing.

The first version should feel close to a simplified Adobe Acrobat viewer, but avoid advanced enterprise/legal PDF workflows unless explicitly added later.

## Implementation Status

### ✅ Implemented

- Standalone Electron desktop application.
- TypeScript, React, Electron, PDF.js, and pdf-lib stack.
- Open local PDFs.
- Drag and drop PDFs into new tabs.
- Multi-PDF tab support.
- Per-tab document state for current page, zoom, view mode, unsaved changes, comments, edits, forms, and signatures.
- Unsaved-change prompt when closing a modified tab or quitting the app.
- Recent files menu.
- Password-protected PDF retry.
- PDF rendering with bundled PDF.js CMaps, standard fonts, and wasm assets.
- Single-page view.
- Two-page view.
- Enable/disable continuous scrolling.
- Page number input and total page count.
- Previous/next page controls.
- Rotate page view.
- Zoom in and zoom out.
- Actual size.
- Fit to page.
- Fit to width.
- Fit height.
- Full screen mode.
- Thumbnail sidebar.
- Bookmarks/outline sidebar.
- Current page indicator.
- Keyboard navigation for page movement, zoom, actual size, find, save, undo, redo, and escape-to-select.
- Text search with match navigation.
- Add text overlays.
- Move and resize added text.
- Edit added text content.
- Change font size.
- Delete added text.
- Add highlights from selected text.
- Add pinned comments from selected text.
- Edit and delete comments.
- Auto-minimize comment popups.
- Persist editable highlights/comments after saving and reopening.
- Save comments and highlights as standard PDF annotations visible in Acrobat-compatible readers by default.
- Detect fillable PDF form fields.
- Fill text fields, checkboxes, radio groups, and dropdowns where supported.
- Preserve form values in saved/exported PDFs.
- Export flattened PDFs.
- Draw signature with mouse/trackpad.
- Type signature as text.
- Upload signature image.
- Place, move, and resize visual signatures.
- Print current PDF with overlays/forms/signatures included.
- Save edited PDF.
- Save as new file.
- Light mode and dark mode.
- Visible theme switcher.
- Remember selected theme.
- Default to operating-system theme on first launch.
- Compact Adobe-like toolbar with Zed-inspired dark visual direction.

### ⚠️ Partially Implemented

- PDF-compatible annotations: comments and highlights save as native PDF annotations by default, while the app still uses private metadata to preserve editable overlay geometry.
- Form filling: basic field types are supported, but complex or malformed form fields may still need hardening.
- Text editing: adding new text overlays works, but full style controls are incomplete.
- Opening PDFs from the operating system: OS handoff exists, but the desired new-window versus existing-window behavior still needs product verification.
- Comments UI: pinned popovers and a comments sidebar exist, but Acrobat-level comment workflows are not complete.

### ⬜ Not Implemented Yet

- Cover-page mode for two-page view.
- Fit visible content.
- Text color control for added text.
- Basic font family selection for added text:
  - Sans.
  - Serif.
  - Monospace.
- Certificate-backed digital signatures.
- Identity verification.
- Audit trails.
- Long-term validation.
- Legal/compliance guarantees.
- Optional inverted-document reading mode.
- Windows packaging/testing.

## Target Platform

- Desktop standalone application.
- Recommended stack: TypeScript, React, Electron.
- Primary PDF rendering library: PDF.js.
- Primary PDF writing/export library: pdf-lib or equivalent.

## Core User Jobs

1. Open and read PDF files locally.
2. Navigate pages quickly.
3. Adjust page view and zoom.
4. Add comments/annotations in a PDF-compatible format.
5. Add simple text overlays to existing PDFs.
6. Fill PDF form fields.
7. Sign a PDF visually.
8. Print the PDF.
9. Save or export the modified PDF.

## Confirmed Scope

### File Handling

- Open local PDF files.
- Drag and drop PDF files into the app.
- Show file name in the app chrome.
- Track unsaved changes.
- Save modified PDF.
- Save as a new PDF.

### Tabs and Windows

- Support multiple open PDFs as tabs.
- Opening a second PDF from inside the app opens it in a new tab.
- Dropping a PDF onto the app opens it in a new tab.
- Each tab has its own document state:
  - Current page.
  - Zoom level.
  - View mode.
  - Unsaved changes.
  - Comments, edits, filled forms, and signatures.
- Tabs can be closed independently.
- Closing a tab with unsaved changes prompts the user to save, discard, or cancel.
- Opening a PDF from the operating system should open a standalone app window unless the product decision changes to route it into the existing window as a new tab.

### Viewing

- Single-page view.
- Two-page view.
- Optional cover-page mode for two-page view.
- Enable/disable continuous scrolling.
- Page number input.
- Total page count display.
- Previous page and next page controls.
- Rotate current page.
- Zoom in.
- Zoom out.
- Actual size.
- Fit to page.
- Fit to width.
- Fit height.
- Fit visible content if technically feasible.
- Full screen mode.

### Navigation

- Thumbnail sidebar.
- Current page indicator.
- Click thumbnail to navigate.
- Keyboard navigation:
  - Arrow keys for page movement.
  - Cmd/Ctrl + plus for zoom in.
  - Cmd/Ctrl + minus for zoom out.
  - Cmd/Ctrl + 0 for actual size or fit default.

### Comments and Annotations

- Add comment to a selected location on a page.
- Display comment marker on page.
- Open comment popover/panel.
- Edit comment text.
- Delete comment.
- Persist comments into the exported PDF using standard PDF annotation structures where possible.
- Use PDF-native annotations rather than app-only metadata when technically feasible.

Initial annotation types:

- Text note/comment.
- Highlight.
- Free text annotation.

### Simple Editing

- Add text box to a page.
- Move text box.
- Resize text box.
- Edit text content.
- Change font size.
- Change text color.
- Basic font selection:
  - Sans.
  - Serif.
  - Monospace.
- Delete added text.

Out of scope for MVP:

- Editing existing embedded PDF text.
- Reflowing document layout.
- Replacing fonts inside the original PDF content stream.
- Advanced object editing.

### Form Filling

- Detect fillable PDF form fields.
- Fill text fields.
- Toggle checkboxes.
- Select radio buttons.
- Select dropdown values if supported.
- Preserve filled values in saved/exported PDF.
- Flatten form fields as an export option.

### Signing

- Draw signature with mouse or trackpad.
- Type signature as text.
- Upload signature image.
- Place signature on page.
- Move and resize signature.
- Apply signature to PDF export.

Out of scope for MVP:

- Certificate-backed digital signatures.
- Identity verification.
- Audit trails.
- Long-term validation.
- Legal/compliance guarantees.

### Printing

- Print current PDF.
- Include comments, added text, filled forms, and visual signature in print output.
- Use operating system print dialog.

### Export

- Save edited PDF.
- Save as new file.
- Export flattened PDF.
- Warn before closing with unsaved changes.

### Appearance

- Support light mode.
- Support dark mode.
- Provide a visible theme switcher.
- Remember the user's selected theme.
- Default to the operating system theme on first launch.

## UI Baseline

The viewer should use a compact Adobe-like control surface:

- Vertical page control rail.
- Top tab bar for open PDFs.
- Page number box.
- Total page count.
- Previous/next page buttons.
- Rotate button.
- View mode menu.
- Zoom in/out buttons.
- Fit/zoom options menu.
- Main document canvas.
- Optional thumbnail sidebar.
- Optional comments/editing sidebar.

The app should prioritize a clean document workspace over a large landing page.

### Visual Direction

The dark theme should follow the broad visual composition of Zed:

- Deep blue-gray workspace background.
- Slightly lighter top bars, sidebars, and bottom bars.
- Subtle borders between panels.
- Muted gray secondary text.
- High-contrast primary text without pure white overuse.
- Small blue accent for selected tabs, active controls, and focus states.
- Compact toolbars with icon-first controls.
- Low visual noise; avoid heavy gradients, large cards, or colorful decoration.

The light theme should keep the same layout and spacing, using a restrained neutral palette:

- White or near-white document workspace.
- Light gray app chrome.
- Clear but subtle panel borders.
- Dark neutral text.
- Same blue accent as dark mode.

PDF page colors must not be inverted automatically. Theme changes affect the app chrome, canvas background, panels, and controls, not the document content itself.

## Non-Goals

- Browser-based SaaS product.
- Cloud document storage.
- Collaboration.
- OCR.
- Redaction.
- Cryptographic signatures.
- Advanced PDF repair.
- Full Acrobat-level editing.
- Mobile app.

## Important Product Decisions

### Editing Existing Text

Editing existing PDF text is not part of the MVP. PDFs do not behave like Word documents; existing text is usually positioned drawing instructions, not editable paragraphs. The MVP should support adding new text overlays.

### Comment Format

Comments should target standard PDF annotations. If a library cannot reliably write every annotation type, the fallback is to store visible annotations in the PDF content and app metadata separately.

### Signing Type

The MVP signature is a visual signature stamp. It is not a cryptographic digital signature.

## Open Questions

1. Should the app support Windows only, macOS only, or both from the first release?
2. Should comments appear in a right sidebar, popovers on the page, or both?
3. Should added comments be visible when opened in Adobe Acrobat?
4. Should annotations be editable after saving and reopening?
5. Should form fields remain interactive after saving, or should export flatten them by default?
6. Should the app remember recent files?
7. Should opening a PDF from the operating system always create a new window, or should it reuse the current window and create a new tab?
8. Should the app support password-protected PDFs?
9. Should it include a search/find text feature?
10. Should it include page thumbnails from the first MVP?
11. Should users be able to insert/delete/reorder pages?
12. Should signing require initials as well as full signatures?
13. Should there be an audit-style signing timestamp, even if not legally cryptographic?
14. Should dark mode also offer an optional inverted-document reading mode, or should PDF content always stay unchanged?

## Missing Features To Consider

These are likely missing from the initial description but common in practical PDF readers:

- Text search.
- Password-protected PDF support.
- Recent files.
- Thumbnails.
- Bookmarks/outline panel.
- Page insert/delete/reorder.
- Undo/redo.
- Multi-window support.
- Select/pan tool.
- Hand tool.
- Copy selected text.
- Download/export button.
- Autosave draft state.
- Error handling for corrupted PDFs.

## MVP Proposal

### Version 0.1

- Open PDF.
- Render pages.
- Page navigation.
- Zoom controls.
- Fit width, fit page, actual size.
- Rotate page view.
- Print.
- Save as/export unchanged PDF.

### Version 0.2

- Add text boxes.
- Draw/upload/type signature.
- Place and resize signature.
- Export modified PDF.
- Unsaved changes handling.

### Version 0.3

- Fill form fields.
- Flatten form export.
- Add comments.
- Add highlights.
- Persist annotations where possible.

### Version 0.4

- Thumbnail sidebar.
- Search.
- Recent files.
- Undo/redo.
- Password-protected PDF support if feasible.

## Success Criteria

- User can open a local PDF and navigate it comfortably.
- User can zoom, rotate, and fit pages using familiar controls.
- User can add text and a signature, then export a modified PDF.
- User can fill basic forms and save/export the result.
- User can add comments/highlights that are visible in the app and preferably visible in Adobe Acrobat.
- User can print the resulting document.

## Risk Areas

- Reliable PDF annotation writing across third-party viewers.
- Editing existing PDF text.
- Form field compatibility across PDF variants.
- Performance on large PDFs.
- Password-protected PDFs.
- Cross-platform printing behavior.
- Packaging, notarization, and code signing.

## Estimated Work

Assuming Electron, TypeScript, React, PDF.js, and visual signatures:

- Basic viewer: 2-3 days.
- Viewing controls and UI polish: 2-3 days.
- Add text and visual signing: 2-4 days.
- Form filling: 2-4 days.
- Comments/highlights: 3-5 days.
- Printing/export hardening: 1-2 days.
- Packaging/installers: 1-3 days.

Estimated useful MVP: 2-3 weeks.

This estimate excludes certificate-backed digital signatures and full existing-text editing.
