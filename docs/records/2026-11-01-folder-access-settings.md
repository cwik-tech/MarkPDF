# Folder access in Settings: implementation record

Date: 2026-11-01. Source: the user's implementation request, follow-up request
for hidden Electron tests, and `docs/folder-access-settings-plan.md` sections 4–7.
Work remains uncommitted on `cwik-tech/folder-access-settings`, based on `main`.

## Decisions and deviations

| ID | Plan or expectation | Implementation and reason |
| --- | --- | --- |
| FA-01 | Main owns the real BrowserWindow lookup; handler tests use fake events and dialogs. | `electron/main.ts`, `registerFolderAccess`, injects `BrowserWindow.fromWebContents(event.sender)` through `windowFor`. `electron/folderAccess.ts`, `isApplicationSender`, receives that window. This preserves the exact runtime check while allowing plain-node tests without mocking the Electron module. |
| FA-02 | Each transaction inspects/resolves a path once; removal also needs its resolved target. | `core/consent/folderAccess.ts`, `Inspection.target`, retains that one resolution for remaining-access notices. A per-transaction inspection cache also supplies reply rows. Calling a resolver again after inspection would contradict the single-resolution rule. |
| FA-03 | Existing tests asserted the old open-document remedy. | The existing assertions in `mcp/commentOperations.test.ts` and `mcp/operations.test.ts` cover path/hash refusals, a different branch of `resolveReadableDocument`. A new reference-specific regression in `mcp/commentOperations.test.ts` demands the Settings remedy. The path/hash remedy is unchanged. The first assertion edits targeted the wrong branch and were reverted before the new regression. |
| FA-04 | Electron journeys launched ordinary desktop windows. | The user explicitly requested non-disruptive testing. `playwright.config.ts` opts into `MARKPDF_TEST_HIDE_WINDOWS`; `electron/main.ts` requires a test profile as well, creates hidden non-focusable windows and suppresses foreground activation. `electron/agentRequests.ts`, `bringToFront`, honors the same opt-in. Playwright's installed Electron launch interface has no headless option. |
| FA-05 | Boundary C can call immediately after navigation. | The initial run hit an execution-context navigation race. The journey now waits for the application page before navigation and the destination URL/load afterward. This is harness synchronization, not product Red evidence. |
| FA-06 | A temporary sender mutation can simply precede the predicate with `return true`. | That version prevented TypeScript narrowing and failed compilation. It was discarded as Electron mutation evidence. Replacing the predicate body with a compilable `return true` exercised boundary C and was restored. |

No deviation changes D1–D6, the record format, CLI behavior, the required
confirmations or the security boundary. No package was added or installed.

## Test-first work and maintenance

The outer acceptance journeys were written before folder-access implementation.
The focused core and handler loops first exposed missing modules, then behavioral
assertion failures after minimal interface scaffolding. The reference-specific
refusal loop exposed the old sentence. The import rule is an existing-boundary
guard and deliberately has no artificial Red phase.

The implementation retains real temporary directories, symbolic links, the
consent record, a separate lock-holder process and a live MCP process. Only
native modal dialog results are substituted in the automated desktop journey;
Vitest handler tests use narrow dialog/event/IPC capabilities. The lower suites
own the rule matrix; Electron proves the coherent Settings and agent outcomes.

Refactoring extracted the resolved-target inspection shared by adding and
listing without adding another resolution. The sender predicate remains separate
from handler registration; UI state remains local to its section. The temporary
implementation mutations are restored. The verification map is in
[the plan](../folder-access-settings-plan.md#11-implementation-verification-map).

## Documentation impact audit

The README consent sentence and the agent refusal remedy table named only the
command line; both now include Settings. The new ADR records the changed consent
channel and current page-script trust model. Only the old MCP ADR's status line
is amended. The changelog records the visible capability. No command arguments,
data format, migrations, dependencies, budgets or recovery command behavior
changed, so their existing references are retained.

## Manual acceptance boundary

The native macOS picker and confirmation were not manually exercised. Tests keep
windows hidden per the user's follow-up instruction. Automated dialogs are
substituted at the native boundary; they do not establish native modal appearance
or hands-on acceptance. Light/dark screenshots, when captured, are visual
inspection of hidden rendered Electron content, not a native-dialog manual check.

## Visual inspection, 2026-11-01

Light and dark screenshots of a hidden Electron window were inspected after the
production build. They show long stored paths wrapping, R/RW selections, a
write-only command-line row with neither choice selected, inherited-write text,
and the add/remove controls. The temporary profile was removed afterward. This
checks rendered appearance, not the real native picker or confirmation.

## Feedback round 1, 2026-11-01

Source: the user's request to address findings 1–7 in Claude's implementation feedback.

- Unexpected initial IPC rejection now ends loading and offers Retry. Its Electron
  regression removes the public list registration to produce a real rejected
  preload call, then restores the actual exported handlers before retrying. It
  uses the real consent file and no fabricated reply.
- An unresolvable picked folder raises `FolderUnreadableError`, preserving its
  cause, so main returns the existing `unreadable` reason without a record write.
- Inherited access is computed against inspection's retained target. The original
  plan's comparison against the row spelling could mislabel a moved child as
  reachable through its former parent. Real symlink regressions cover both access kinds.
- Unavailable R/RW controls use `aria-disabled` and guarded activation. They remain
  focusable so tooltips can explain them. The keyboard journey covers both choices.
- The core and handler modules were reformatted while Green. Short comments now
  explain single resolution, stored-name withdrawal, the required affected set and
  complete sender-URL comparison. The General-page fragment was re-indented.
- The changelog also records the open-document refusal's Settings remedy.
- Built-renderer verification uses a separate temporary build with encoded spaces
  in its file URL. The repository's existing renderer output is retained. This is
  an explicit check rather than a permanent default-suite test; the default
  Electron suite continues to use its configured Vite server.

The original hidden-window mode is unchanged. Because those windows have
`focusable: false`, these journeys cannot establish native window-focus behavior,
including the section's refresh on real window focus. Native-dialog hands-on
acceptance remains outside this hidden run. Results and Red evidence are appended
to the delivery report's Feedback round 1 section.

## Folder row alignment and tooltip visibility, 2026-11-01

Source: the user's screenshot and request to align folder controls and use shadcn tooltips.

The shared shadcn tooltips were mounted, but their default layer sat beneath the
Settings overlay. The Electron regression now checks the painted element at the
tooltip center rather than accepting DOM visibility alone. The section uses the
same tooltip layer as the existing Settings information tooltip and adds a
shadcn tooltip to Remove.

A section-specific grid keeps the R/RW group and Remove in consistent columns
when folder path lengths differ. Folder icons retain their size and long paths
can wrap. This is presentational work; no test asserts CSS classes or row markup.
Rendered inspection checks alignment. Hidden-window mode is unchanged.
