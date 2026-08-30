# Quit cancels OCR before completing asynchronous window closure

## Status

Accepted.

## Context

MarkPDF guards every `BrowserWindow` close event so the renderer can ask about unsaved tabs. That
guard calls `preventDefault()`, sends `window:request-close`, and closes the window only after the
renderer answers through `window:close-after-confirm`.

On macOS, an explicit `app.quit()` was therefore cancelled at the first window. The renderer later
closed the confirmed window, but the `window-all-closed` handler followed normal macOS behavior and
kept the application process alive. An active semantic-index job made the defect conspicuous because
its Tesseract worker continued recognising pages in the process the user had asked to quit.

Cancellation also reached core OCR only between pages. A page already inside
`worker.recognize()` could take tens of seconds, and `ocrPages` did not close the worker until that
promise returned.

## Decision

Record explicit quit intent in the Electron main process. When the last window closes, call
`app.quit()` on macOS only if that explicit intent was recorded. Closing the last window with the
window control keeps the ordinary macOS behavior and leaves the application running. If the user
cancels an unsaved-document prompt, the renderer reports that outcome and clears the recorded quit
intent before any later window close.

Cancel every semantic-index job during `before-quit`, before the asynchronous window confirmation
starts. Core OCR races active recognition against its `AbortSignal`. If cancellation wins, it closes
the Tesseract worker immediately and uses one shared close promise so normal cleanup cannot terminate
the same worker twice.

> **Learning note:** Preventing a window close also cancels the `app.quit()` attempt that initiated
> it. Closing the confirmed window later does not resume that attempt, so the final-window handler
> must issue a new quit when the original request was explicit.

## Consequences

- Explicit Quit completes after the renderer resolves any unsaved-document decisions.
- Active and queued semantic-index jobs receive cancellation as soon as Quit starts.
- Recognition of the current page no longer delays worker termination.
- Closing the last window without choosing Quit still leaves MarkPDF available on macOS.
- Cancelling an unsaved-document prompt cancels the pending Quit rather than changing how a later
  window close behaves.
- A cancelled recognition call returns the pages completed before cancellation and writes no partial
  current page.

## Alternatives considered

- **Force-close every window after a timeout.** Rejected because a blocked renderer could lose an
  unsaved edit without showing the confirmation dialog.
- **Quit whenever the last macOS window closes.** Rejected because it would replace standard macOS
  window behavior and make the red window control equivalent to Quit.
- **Check cancellation only between OCR pages.** Rejected because one complex page reproduced the
  reported shutdown delay.

## Verification

- `electron/quitPolicy.test.ts` proves an explicit macOS quit continues after the confirmed last
  window closes while an ordinary last-window close does not.
- `core/ocr/ocrStreaming.test.ts` proves cancellation during recognition closes the engine without
  waiting for the page promise.
- `tests/e2e/mixed-document-ocr.spec.ts`, "closes promptly while OCR is reading a page", drives the
  real Electron quit path during main-process OCR and requires process exit within two seconds.
- Mutation proof removed explicit-quit handling from the macOS policy and changed the OCR abort
  listener to an unused event. Their focused tests failed before both behaviors were restored.
