# Implementation plan: Folder access in Settings > General

Status: reviewed. Revised after two Codex reviews on 2026-11-01: one of the requirements and one of this plan. Date: 2026-11-01.
Requirements: `docs/folder-access-settings-prd.md` (decisions D1 to D6 in its section 10).
Evidence is cited as `file:line`. A claim without a citation is marked **unverified**.

## 1. Goal and acceptance criterion

A person can see, change, add and remove the folders that agents may use, from Settings > General, without the command line.

Acceptance criterion: in the running app, a person opens Settings > General and sees each granted folder with R or RW. The person changes a level, adds a folder with the folder picker, and removes a folder after a confirmation. After each action, `<userData>/consent/allowlist.json` on disk holds the new grants, and the next MCP tool call uses them without a restart.

## 2. Classification (`AGENTS.md`, "Choose the loop shape")

This work is a new cross-layer user capability: renderer, preload, IPC, main process, core and a file on disk. Thus:

- Outer acceptance tests come first: Electron journeys in `tests/e2e/`.
- Focused inner loops drive the rules: core first, then the main-process handlers.
- There is one vertical capability, "manage agent folder access from Settings". It has two user outcomes, the main journey and cancellation, and one security boundary at the preload bridge. Each gets its own Electron test (`AGENTS.md`, "Double-loop TDD"). The rule matrices stay in the core and electron unit tests.

## 3. Facts the plan relies on

| # | Fact | Evidence |
|---|---|---|
| F1 | Grants are two separate lists. Neither list implies the other. Effective access is the union of containing roots, separately for read and write. `isAllowed` resolves the request target but never a stored root. | `core/consent/allowlist.ts:23-26`, `:114-130` |
| F2 | `applyGrants` resolves every input path again, also for a withdrawal, and stores the result. An "allow" of a held root does nothing (`already-granted`). | `core/consent/allowlistFile.ts:108-124` |
| F3 | A withdrawal reaches downwards. It removes the named root and every stored root inside it. | `core/consent/allowlistFile.ts:94-97`, `:123-131`, test `core/consent/allowlistFile.test.ts:118-125` |
| F4 | `covered-by-ancestor` is reported only when a withdrawal removes nothing. | `core/consent/allowlistFile.ts:125-141` |
| F5 | A missing record reads as empty. A damaged record throws `AllowlistFileError` and is never treated as empty. | `core/consent/allowlistFile.ts:147-197`, tests `core/consent/allowlistFile.test.ts:451-481` |
| F6 | `updateAllowlist` is a locked read, apply and write of unconditional grants. `withAllowlistLock` is the exported primitive for other consent changes. | `core/consent/allowlistFile.ts:337-370` |
| F7 | The lock is exclusive and fails fast with `AllowlistLockedError`. An abandoned lock carries `recoverCommand` and is never taken over. | `core/consent/allowlistFile.ts:20-45`, `:292-322` |
| F8 | `resolveRealPath` throws for a failure other than a missing path, for example a self-referencing link (`ELOOP`). | `core/consent/allowlist.ts:83-102` |
| F9 | The MCP server reads the record on every tool call. | `mcp/context.ts:134` |
| F10 | The desktop reads the record on every agent request. A running CLI command keeps the snapshot it read at its start. | `electron/agentRequests.ts:209-213`, `cli/run.ts:73-76`, `cli/context.ts:80` |
| F11 | The desktop data directory is `app.getPath("userData")`, and tests override it with `MARKPDF_TEST_USER_DATA` or `MARKPDF_DATA_DIR`. | `electron/main.ts:123-134` |
| F12 | The core default data directory is `~/Library/Application Support/markpdf`. On the development Mac this folder holds the desktop's own files and the record. | `core/paths.ts:13`, `:28`. Observed 2026-11-01. |
| F13 | Today, no MCP or desktop agent module imports a function that writes grants. They import only `readAllowlist`, `requireAccess` and `resolveRealPath`. Only the CLI imports `updateAllowlist`. | `mcp/context.ts:6`, `electron/agentRequests.ts:20-21`, `electron/agentPreparation.ts:10-11`, `cli/context.ts:11` |
| F14 | Settings has a General page, rendered by `GeneralSettingsPage`. It holds only "Default Application". | `src/AISettings.tsx:72`, `:523-530`, `:661-741` |
| F15 | The bridge groups methods by area, for example `cliInstall` and `defaultApp`. | `electron/preload.ts:132-141`, `src/global.d.ts:405-415` |
| F16 | A native confirmation in main already exists as a pattern. | `electron/main.ts:635-659` (`dialog:confirm-unsaved`) |
| F17 | The shared UI primitives are only `button.tsx` and `tooltip.tsx`. There is no dialog and no toggle group. | `src/components/ui/` |
| F18 | An Electron journey can stub one native dialog in main with `app.evaluate`, and keep the UI, preload, handler and filesystem real. | `tests/e2e/markdown-mermaid-viewer.spec.ts:233-245` |
| F19 | The Settings journey for the command line is the precedent for launch options, a temporary data directory and opening Settings. | `tests/e2e/cli-install.spec.ts:56-110` |
| F20 | An Electron journey can drive the real MCP server with the official SDK client. | `tests/e2e/open-documents-mcp.spec.ts:4`, `:27`, `:82` |
| F21 | `outline` refuses a document outside the grants with `isError: true` and the text "Not permitted to read …". It has no `access_denied` code. It reads the index first. | `mcp/operations.ts:168-172`, `:222-232`, `mcp/server.ts:148-149`, `:201-202` |
| F22 | The window uses `contextIsolation: true` and `nodeIntegration: false`. `sandbox` is `false`. The bridge is exposed to page script in every window, including agent windows. | `electron/main.ts:359-364`, `electron/preload.ts:59-60` |
| F23 | `createWindow` loads `VITE_DEV_SERVER_URL` when it is set, and otherwise the file `../dist/index.html`. | `electron/main.ts:408-414` |
| F24 | Electron gives `IpcMainInvokeEvent.senderFrame` (nullable), `event.sender.mainFrame`, and `WebFrameMain.isDestroyed`, `detached` and `url`. | `node_modules/electron/electron.d.ts:8840-8861`, `:17874-17879`, `:18198-18235`, `:18335-18338` (cited by the Codex review) |
| F25 | New windows are denied. No same-window navigation guard exists, and `index.html` has no Content Security Policy. | `electron/main.ts:383-386`. A grep for `will-navigate` in `electron/` returned nothing on 2026-11-01. |
| F26 | The renderer can already read and write any file path through IPC, without path checks. | `electron/main.ts:661-708` (`file:read-pdf`, `file:write-markdown`), `electron/preload.ts:103-104` |
| F27 | Markdown renders as React elements. Mermaid runs with `securityLevel: "strict"`, which sanitizes its SVG with DOMPurify. | `src/markdown/MarkdownPreview.tsx:94-141`, `src/markdown/MermaidDiagram.tsx:251-261`, `node_modules/mermaid/dist/mermaid.core.mjs:1355-1364` (cited by the Codex review) |
| F28 | A root can be a file. | `core/consent/allowlist.ts:37-40` |
| F29 | `read_pages` and `search` need no filesystem grant. | `mcp/operations.ts:482-493` (`read_pages`), `mcp/operations.ts:314` and `core/index/documentLookup.ts:43-68` (`search`) |
| F30 | The MCP refusal text for an open document tells the agent to use the command line only. | `core/agent/documentTarget.ts:44` |
| F31 | `npm run test:e2e` builds core, CLI, MCP and Electron before Playwright. `pretest` does not build Electron. | `package.json:22`, `:35` |
| F32 | A real lock-holder process for tests already exists. | `core/consent/allowlistFile.test.ts:263-293`, `core/consent/holdAllowlistLock.test-support.mjs:20-32` |
| F33 | `core/modelParity.test.ts` compares runtime values, not interfaces, and is excluded from `typecheck:tests`. | `core/modelParity.test.ts:17-31`, `tsconfig.test.json:18-21` (cited by the Codex review) |

## 4. Design

### 4.1 Core: `core/consent/folderAccess.ts` (new)

Pure Node. No Electron import (`core/boundaries.test.ts` enforces this).

**Rule of the transaction.** The consent lock protects the record. It does not protect the identity of a directory on disk. Thus each path is resolved or inspected **at most once** in a transaction. The transaction builds the next record from that one result and writes that exact record. It never calls `applyGrants`, because `applyGrants` resolves every path again (F2), and it never calls `updateAllowlist`, because the lock cannot be nested (F7). The CLI keeps `applyGrants` and `updateAllowlist` unchanged.

Types:

```ts
export type FolderLevel = "read" | "write" | "read-write";   // "write" only for a root the CLI made
export type SettableLevel = "read" | "read-write";           // D1: Settings never sets "write"
export type RootStatus = "present" | "missing" | "moved" | "unreadable";

export interface FolderRow {
  path: string;              // the stored root, exactly as stored
  kind: "folder" | "file" | "unknown";
  level: FolderLevel;        // explicit: which lists hold this exact root
  status: RootStatus;
  readThrough?: string;      // set when this row has no explicit read, and another root gives read here
  writeThrough?: string;     // set when this row has no explicit write, and another root gives write here
}

export type FolderChange =
  | { kind: "add"; path: string }
  | { kind: "set-level"; path: string; level: SettableLevel }
  | { kind: "remove"; path: string };

export interface FolderPreview {
  adds: { read: boolean; write: boolean };   // access this change adds to the row
  withdraws: { read: boolean; write: boolean };
  withdrawn: string[];       // sorted, unique: every other stored root that a withdrawal also removes (F3)
}

export interface FolderChangeResult {
  folders: FolderRow[];
  changed: boolean;
  withdrawn: string[];
  stillReachable?: { read?: string; write?: string; unknown?: true };  // after a removal
}
```

A row has at least one explicit grant. Thus a row can have `readThrough` or `writeThrough`, but not both. An R child under an RW parent has `writeThrough`. A write-only child under an R parent has `readThrough`.

`status` comes from one inspection of the stored root:
- `present`: the root exists, and `resolveRealPath(root) === root`.
- `missing`: the root does not exist (`isMissingPathError`, `core/consent/allowlist.ts:66-71`).
- `moved`: the root exists but resolves to a different path, because the root or an ancestor was replaced by a link (F2).
- `unreadable`: the inspection threw for another reason, for example `ELOOP` (F8).

Functions:

1. `listFolders(allowlist, inspect = defaultInspect): FolderRow[]`. One row for each distinct stored root, sorted by path. `readThrough` and `writeThrough` use `containsPath` (`core/consent/allowlist.ts:114-118`) between a containing stored root and the inspected request target. The stored row spelling is a fallback only for a `present` inspection without a target. A moved row must not claim access through its former parent (feedback round 1, finding 4). `inspect` is injectable, so that tests can fix `status` and `kind`.
2. `planFolderChange(allowlist, change, inspection): { next: Allowlist; preview: FolderPreview } | Refusal`. A pure function with no filesystem access:
   - `set-level` and `remove` need a `change.path` that exactly equals a stored root. Otherwise the result is the refusal `not-listed`.
   - Classify added and withdrawn access separately from the current explicit level:

     | Current | Target | Adds | Withdraws |
     |---|---|---|---|
     | read | read-write | write | none |
     | read-write | read | none | write |
     | write | read | read | write |
     | write | read-write | read | none |
     | same | same | none | none |
     | any | remove | none | read and write |

   - Any change that adds access needs `inspection.status === "present"`. Otherwise the result is the refusal `missing`, `moved` or `unreadable`. A write-only row going to R adds read, so this check applies to it too.
   - To add access, append the **stored string** to the list. Never resolve it again.
   - To withdraw access, use the stored root string as the only boundary. It is canonical already, because it is a stored root. Remove that root and every stored root that it contains lexically (`containsPath`). No resolution is needed, so an `unreadable` root can be narrowed and removed (F8).
   - `add` uses the path that the transaction resolved once. If that path exactly equals a stored root in either list, return `changed: false` and keep its level (PRD US-3). Otherwise append it to `readRoots` only (D4). Ancestor coverage does not count as "already granted".
   - `preview.withdrawn` is the sorted, unique union of the other roots that all withdrawals in the change remove.
3. `previewFolderChange(dataDir, change, inspect = defaultInspect): FolderPreview | Refusal`. Read the record without the lock, inspect once, and call `planFolderChange`. Main uses it for the confirmation text.
4. `changeFolderAccess(dataDir, change, expectedWithdrawn, deps = { withLock: withAllowlistLock, inspect: defaultInspect, resolve: resolveRealPath })`. One indivisible change, inside **one** `deps.withLock(dataDir, …)`:
   - Read the record with `readAllowlist`. A damaged record throws `AllowlistFileError` (F5), and nothing is written.
   - For `add`, call `deps.resolve` once on the picked path. For the other kinds, call `deps.inspect` once on the stored root.
   - Call `planFolderChange` on that snapshot. A refusal throws a typed error (`FolderNotListedError`, `FolderMissingError`, `FolderMovedError`, `FolderUnreadableError`), and nothing is written.
   - `expectedWithdrawn` is required for `set-level` and `remove`, also when it is `[]`. If the planned `withdrawn` set is not equal to it, throw `FolderNotListedError` with a fresh list, and write nothing. This rule also covers an R-to-R request that became a withdrawal because the CLI changed the record in between.
   - Write the planned `next` with `writeAllowlist`, exactly as planned.
   - After a removal, compute `stillReachable` against the request target, as the access check does (F1). Resolve the stored path once. Name the nearest root in `next.readRoots` and in `next.writeRoots` that contains the resolved target. If resolution throws, return `unknown: true`. Never infer reachability from the stored spelling alone.
   - The injectable `withLock` exists only so that a test can make a CLI change between the call and the lock (section 5, loop 1). Production always uses `withAllowlistLock`.

### 4.2 Main process: `electron/folderAccess.ts` (new)

`registerFolderAccess({ dataDir, ipc, dialog, entryUrl })` registers four handlers. `electron/main.ts` calls it once, next to `registerAgentRequests` (`electron/main.ts:133`), with `dataDir: () => app.getPath("userData")` (F11).

**Sender check.** One exported predicate, `isApplicationSender(event, entryUrl)`, runs first in every handler. It refuses with `untrusted` unless all of these are true (F24):

- `event.senderFrame` is not null, not destroyed and not detached.
- `event.senderFrame` is `event.sender.mainFrame`.
- `BrowserWindow.fromWebContents(event.sender)` is a window that is not destroyed.
- The frame URL, without its hash, equals `entryUrl` exactly. A query is not allowed. A prefix match is not allowed.

`entryUrl` comes from one function that `createWindow` also uses for its load target (F23), so the two cannot disagree:
- When `VITE_DEV_SERVER_URL` is set: `new URL(VITE_DEV_SERVER_URL).href`. This normalizes `http://127.0.0.1:5173` to `http://127.0.0.1:5173/`, which is what the frame reports.
- Otherwise: `pathToFileURL(<the dist/index.html path>).href`, which encodes spaces in the path. An origin check is not used, because every `file:` URL has the origin `"null"`.

Whether the application uses the URL hash for navigation is **unverified**. The predicate ignores the hash so that hash navigation stays allowed.

The predicate does not prove that a person clicked (section 4.6).

**Handlers:**

| Channel | Input (validated in main) | Behavior |
|---|---|---|
| `folder-access:list` | none | `listFolders(readAllowlist(dataDir))` |
| `folder-access:set-level` | `unknown`. It must be `{ path: string, level: "read" \| "read-write" }`. | Call `previewFolderChange`. If `withdrawn` is not empty, show a native confirmation that names those roots (F16). Then call `changeFolderAccess` with that `withdrawn` as `expectedWithdrawn`, also when it is `[]`. |
| `folder-access:add` | none | `dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] })`. Cancel returns `cancelled: true`. Otherwise `changeFolderAccess({ kind: "add", path }, [])`. |
| `folder-access:remove` | `unknown`. It must be `{ path: string }`. | Call `previewFolderChange`. Always show a native confirmation (D5). It names the root and every root in `withdrawn`, and says that indexed content stays searchable (F29). On confirm, call `changeFolderAccess` with that `withdrawn`. On cancel, change nothing. |

Reply shape:

```ts
type FolderAccessReason =
  | "damaged" | "busy" | "lock-abandoned" | "changed"
  | "missing" | "moved" | "unreadable" | "invalid" | "untrusted";

type FolderAccessReply =
  | { ok: true; folders: FolderRow[]; changed: boolean; cancelled?: true;
      withdrawn?: string[]; stillReachable?: { read?: string; write?: string; unknown?: true } }
  | { ok: false; reason: FolderAccessReason; message: string;
      folders?: FolderRow[]; recoverCommand?: string };
```

This follows the existing `ok` and `reason` convention (`electron/cliInstall.ts:43-48`, `src/global.d.ts:311-315`), with `message` for the display text.

Error mapping:
- `AllowlistFileError` maps to `damaged`, with no `folders`. The page shows an error, not an empty list.
- `AllowlistLockedError` without `recoverCommand` maps to `busy`. With `recoverCommand`, it maps to `lock-abandoned`, and the reply carries the command for display only.
- `FolderNotListedError` maps to `changed`, with a fresh list.
- `FolderMissingError`, `FolderMovedError` and `FolderUnreadableError` map to `missing`, `moved` and `unreadable`.
- A bad input maps to `invalid`.

Decision: the confirmations are native message boxes in main, not renderer dialogs. Reasons:

- The pattern exists (F16), and the repository has no dialog primitive (F17).
- A renderer call cannot skip a confirmation that main shows.

### 4.3 Bridge and declaration

- `electron/preload.ts`: add `folderAccess: { list, setLevel(path, level), add, remove(path) }` beside `cliInstall` (F15).
- `src/global.d.ts`: add `FolderAccessLevel`, `FolderAccessRow`, `FolderAccessReason` and `FolderAccessReply`, and the `folderAccess` member of `window.pdfReader`. The renderer cannot import core, so the shape is mirrored.
- Contract check: a compile-time, two-way assignability check between the core types and the mirrored types, in a test-source file that `tsconfig.test.json` includes and does not exclude. `core/modelParity.test.ts` is not the pattern here, because it compares runtime values and is excluded from that gate (F33). Runtime validation of the IPC input stays in main.
- Risk, **unverified**: `tsconfig.test.json:18-20` excludes `core/modelParity.test.ts` because core and renderer use two module-resolution rules. A type-only check can meet the same problem. Try it first. If `tsc` cannot resolve both halves in one file, record the gap in the delivery and do not add a runtime copy of the types.

### 4.4 Renderer: `src/FolderAccessSection.tsx` (new)

`GeneralSettingsPage` renders the section below "Default Application" (`src/AISettings.tsx:676-741`). The section loads its own data, so the settings component (1,403 lines) gets only one new line.

- Heading "Folder access", with the text "Folders that agents can open through the markpdf command and MCP, in this MarkPDF data directory." and an "Add folder" button.
- One `agent-row` for each root, with the full path. A file root shows a file icon.
- Status text: `missing` shows "Not found". `moved` shows "Moved or replaced. Remove it and add it again." `unreadable` shows "Cannot check this folder".
- Inherited access: "Also readable through <readThrough>" or "Also writable through <writeThrough>".
- A button group with `role="group"` and `aria-label="Access for <path>"`. It has two buttons, "R" and "RW", each with `aria-pressed` and a tooltip from `src/components/ui/tooltip.tsx` (D2):
  - R: "Read. Agents can find and read files here."
  - RW: "Read and write. Agents can also save files here."

  Each button's accessible name is the full word ("Read", "Read and write"). A `write` row shows "Write only, set by the command line", with neither button pressed. When `status` is not `present`, every button that adds access is disabled: RW on any row, and also R on a write-only row.
- A remove button, an icon with `aria-label="Remove <path>"`.
- Empty state: "No folders are granted for direct file access in this MarkPDF data directory. Agents can still search and read documents that are already indexed."
- Damaged record: the message and no controls. Abandoned lock: the message and the recovery command as text to copy.
- After a removal, a notice that matches `stillReachable`: "Agents can still read it through <read>", "Agents can still save files in it through <write>", both sentences, or "MarkPDF cannot check whether agents can still reach it". No notice when neither is set.
- While an action runs, the row's controls are disabled. A failed action keeps the saved row and shows the message. Access buttons use `aria-disabled` with guarded activation, so unavailable choices still explain themselves through keyboard and pointer tooltips.
- If the initial list call rejects unexpectedly, loading ends, the error is shown, and Retry reloads through the same bridge (feedback round 1, findings 2 and 5).
- The section reloads the list when the window gains focus, so a command-line change shows up.

Reuse the existing classes: `settings-section`, `settings-section-heading`, `agent-list`, `agent-row`, `secondary-button`, `empty-row`, `settings-note` (`src/AISettings.tsx:676-741`). Scope the row alignment and two-button group CSS in `src/styles.css` to folder access. The row uses a flexible path column followed by fixed-width access controls and Remove; shadcn tooltips render above the Settings overlay.

### 4.5 Agent refusal text

`core/agent/documentTarget.ts:44` says "Grant its folder with markpdf --allow-read, as a separate command." Change it to "Ask the person to grant its folder in MarkPDF Settings > General, or with markpdf --allow-read." Change the remedy table in `docs/agent-evidence-and-comments.md:84` in the same way. The tests that assert the old sentence change in the same step.

### 4.6 Architecture decision record

Write `docs/adr/2026-11-01-Folder-Access-In-Settings.md`. It amends `docs/adr/2026-08-23-MCP-Server-Adapter.md:67-70` ("Consent is given out of band, with the command line"). It records:

- Consent is given out of band by a person: on the command line, or in desktop Settings.
- No MCP tool, `markpdf` agent command or desktop agent request can change grants. The import guard (section 5, loop 4) and the sender check (section 4.2) enforce this.
- **The trust model.** The handlers trust the application's own page script in the main frame. They do not prove that a person clicked. Add and remove need a native dialog. A narrowing without other affected roots, and a widening from R to RW, do not.
- **Why no native confirmation for widening.** The application page can already read and write any file through IPC, including the consent record itself (F26). A script that could call `setLevel` could also write files directly. A confirmation on R to RW would add a dialog for each change and would not reduce that power. The Codex plan review agreed with this reasoning under the current boundary.
- **What keeps document content out of the page script today:** React rendering of Markdown and Mermaid strict mode (F27), the new-window handler, and filtered PDF links. A navigation guard and a Content Security Policy do not exist (F25). A future feature that renders raw HTML from a document must revisit this decision.
- **The consent lock protects the record, not directory identity.** The transaction resolves each path once and writes exactly what it planned (section 4.1).
- **Follow-up hardening, outside this feature:** a same-window navigation guard, a Content Security Policy, and path checks on the file IPC (F25, F26).

## 5. Test-driven sequence

Record the test file, the command, the expected Red failure and the reason for each loop.

The focused outer command is `heavy-run --label markpdf -- npm run test:e2e -- tests/e2e/folder-access-settings.spec.ts`. It rebuilds core, CLI, MCP and Electron before Playwright (F31). A plain `npx playwright test` would run a stale `dist-electron/`. A Red that comes from a stale build or a failed launch is not valid Red evidence.

### Outer tests, written first

File: `tests/e2e/folder-access-settings.spec.ts`. Write all three tests before any implementation.

**Journey A: "manages the folders agents can use from Settings".**

1. Arrange: make a temporary directory and canonicalize it with `realpath` before you seed or assert paths, so that a `/var` to `/private/var` alias does not make a `moved` fixture. Seed `user-data/consent/allowlist.json` with one read root, folder A. Create folder B with a small text-bearing PDF that is not indexed and not open. Which existing fixture to copy is **unverified**. Launch the app with the options from F19.
2. Open Settings > General. Expect the row for A, with "Read" pressed.
3. Click "Read and write" for A. Poll the record: A is in `readRoots` and `writeRoots`.
4. Stub `dialog.showOpenDialog` to return B (F18). Click "Add folder". Expect a row for B with "Read" pressed. Poll the record: B is in `readRoots` only.
5. Start one official SDK client against the real MCP server with the same data directory (F20). Call `outline` with the PDF path in B, with a bounded timeout. Expect success.
6. Stub `dialog.showMessageBox` to return the confirm button. Click "Remove B". Expect no row for B. Poll the record: B is in neither list.
7. Call `outline` again with the same client. Expect `isError: true` and content that contains "Not permitted to read" (F21). B must not be indexed, because `outline` reads the index first (F21). Close the client in `finally`.

**Journey B: "cancelling the picker or the removal changes nothing".**

1. Arrange: the record holds folder A with R.
2. Stub the picker to return `canceled: true`. Click "Add folder". Expect the same rows. The record bytes are unchanged.
3. Stub the message box to return the cancel button. Click "Remove A". Expect the row for A. The record bytes are unchanged.

**Boundary test C: "a page that is not MarkPDF cannot use folder access".**

1. Arrange: the record holds folder A with R.
2. Load a different page into the window from main, for example a `data:` URL, with `app.evaluate`. The real preload bridge loads with it (F22).
3. In that page, call `window.pdfReader.folderAccess.setLevel(A, "read-write")`. Expect `ok: false` and `reason: "untrusted"`. The record bytes are unchanged.

Expected Red for all three: A and B time out at the first step that needs the "Folder access" section, because it does not exist. C fails because `window.pdfReader.folderAccess` is undefined. Each failure is the requested behavior missing. B also guards the cancel paths at the journey level, but its Red is the missing capability. The cancellation-specific Red comes from loop 2.

### Inner loop 1: core rules

File: `core/consent/folderAccess.test.ts`. It uses real temporary directories and real links.

- A root in both lists is one `read-write` row. A root only in `writeRoots` is a `write` row.
- An R child under an RW parent has `writeThrough`. A write-only child under an R parent has `readThrough`. These are two separate rows.
- A file root keeps `kind: "file"` and its own path.
- `status` is `missing` for a deleted root, `moved` when the root or an ancestor is replaced by a link, and `unreadable` for a self-referencing link.
- `planFolderChange` follows the table in section 4.1, including write-only to R, which adds read and withdraws write.
- `set-level` and `remove` refuse a path that is not exactly a stored root, and leave the record unchanged.
- **Single resolution.** Inject a `resolve` and an `inspect` that return a different value on the second call. The stored root is the first value, and the second call never happens.
- **Moved root.** Widening a `moved` root is refused, and no new target is stored. Removing it succeeds.
- **Unreadable root.** Narrowing and removing a root that is a self-referencing link succeed. Widening it is refused.
- `add` of an exact stored root changes nothing and keeps its level. `add` of a folder inside a granted folder adds a new R root.
- `remove` of a parent also removes a nested root, and `withdrawn` names it.
- **Changed set.** A `withdrawn` set that differs from `expectedWithdrawn` refuses and writes nothing. Cover write-only to R with a nested write root, and an R-to-R request that became a withdrawal because a parent gained write in between.
- **Remaining access.** After removing a stable child under a read parent, `stillReachable.read` names the parent. After removing a child that was replaced by a link to a place outside the parent, `stillReachable` does not claim read. A write-only parent gives `write` and no `read`.
- **Placement under the lock.** Inject a `withLock` that first revokes the root through `updateAllowlist`, as the CLI would, and then calls the real `withAllowlistLock`. `set-level` on the old path must refuse with `FolderNotListedError`, and the root must stay revoked.
- A damaged record throws `AllowlistFileError`, and the record bytes are unchanged.
- A lock held by a separate process gives `AllowlistLockedError`, and the record is unchanged. Copy the lock-holder pattern from F32.

Command: `npm test -- core/consent/folderAccess.test.ts`.
Expected Red: the module does not exist. Add only the exported names, then confirm assertion failures before the implementation.

### Inner loop 2: main-process handlers

File: `electron/folderAccess.test.ts`. It uses a real temporary data directory, and fake `ipc`, `dialog` and event objects.

- `isApplicationSender`, tested directly with real URL strings: accepts the packaged `file:` URL with encoded spaces and the normalized dev URL. Refuses an unrelated `file:` URL, a lookalike such as `http://127.0.0.1:51730/`, a URL with a query, a subframe, a null frame, and a destroyed or detached frame.
- Every handler refuses an `untrusted` sender before it reads input, and the record is unchanged.
- A non-object input, a non-string path, or the level `"write"` gives `invalid`, and the record is unchanged.
- `remove` with the cancel button changes nothing. With the confirm button, it removes the root.
- `set-level` to R on a root with nested write roots asks first. Without nested roots, it does not ask, and it still passes `[]` as `expectedWithdrawn`.
- `add` with a cancelled picker changes nothing.
- A damaged record gives `damaged` without `folders`. An abandoned lock gives `lock-abandoned` with `recoverCommand`, and the lock file still exists.

Command: `npm test -- electron/folderAccess.test.ts`.

### Inner loop 3: refusal text

Update the tests that assert the old sentence from F30, and run them Red against the old text. Then change `core/agent/documentTarget.ts:44`.

### Inner loop 4: import guard

Extend `core/boundaries.test.ts`, or add `electron/folderAccessBoundary.test.ts`. The rule: no file in `mcp/`, and none of `electron/agentRequests.ts`, `electron/agentRequestTargets.ts` or `electron/agentPreparation.ts`, may import `updateAllowlist`, `writeAllowlist`, `withAllowlistLock`, `applyGrants`, `core/consent/folderAccess` or `electron/folderAccess`. This test passes today (F13). It is a guard, not new behavior, so it has no Red. A mutation proves that it bites: add a temporary import to `electron/agentRequests.ts`, confirm the failure, then remove it.

### Contract check

The two-way type check from section 4.3 runs in `npm run typecheck:tests`. Prove that it bites: change one mirrored field in `src/global.d.ts`, confirm the type error, then restore it.

### Mutation proofs (security, persistence and concurrency, `AGENTS.md`)

1. Remove the exact-root check in `planFolderChange`. The not-listed tests in loop 1 must fail.
2. Move the read and the exact-root check outside `withLock`. The placement test in loop 1 must fail.
3. Resolve the stored root again before storing it. The single-resolution test in loop 1 must fail.
4. Remove the `present` check before widening. The moved-root test in loop 1 must fail.
5. Make `expectedWithdrawn` optional and skip the check when it is missing. The changed-set tests in loop 1 must fail.
6. Make `folder-access:remove` skip the confirmation. Loop 2 must fail.
7. Make `add` grant read and write. Loop 1 and journey A must fail.
8. Make `isApplicationSender` return `true`. Loop 2 and boundary test C must fail.

Restore each mutation and run the test again.

## 6. Work order

1. Outer tests A, B and C, Red.
2. Core loop 1.
3. Main loop 2, then the bridge, the declaration and the contract check.
4. Renderer section. A, B and C go Green.
5. Loop 3, refusal text.
6. Loop 4, import guard, with its mutation.
7. Manual check in the running app: the real macOS folder picker, the real confirmation, and the section in light and dark themes.
8. ADR, `CHANGELOG.md` entry, and the sentence at `README.md:186`, which says that permission is given only with the command line.

## 7. Verification commands

During the loops, run only the narrow command for the current file. Before the merge:

- `npm run build:core`
- `npm run typecheck`, `npm run typecheck:core`, `npm run typecheck:tests`, `npx tsc -p tsconfig.electron.json --noEmit`
- `heavy-run --label markpdf -- npm test`
- `heavy-run --label markpdf -- npm run build`
- `heavy-run --label markpdf -- npm run test:e2e`
- Lint: the repository has no lint command. Report it as unavailable.

## 8. Falsification pass

I checked these assumptions against the code because each one can break the design. The two Codex reviews found most of the false ones.

| Assumption | Result |
|---|---|
| A Settings change applies without a restart. | Confirmed for the next MCP call and the next desktop agent request (F9, F10). A CLI command that is already running keeps its snapshot. |
| The UI and the MCP server use the same record. | Confirmed in the default setup (F11, F12). An override such as `MARKPDF_DATA_DIR` can make them differ. The UI text says "in this MarkPDF data directory". |
| `updateAllowlist` or `applyGrants` can do the change. | False. Neither can check under the same lock that a row still exists, `applyGrants` resolves each path again (F2), and the lock cannot be nested (F7). Section 4.1 adds a separate transaction. |
| The lock makes the change safe from disk changes. | False. It protects only the record. The transaction resolves each path once and writes exactly what it planned. |
| An "allow" on a stored root keeps that root. | False when the root was replaced by a link (F2). Widening needs `status: "present"` and appends the stored string. |
| A root that cannot be inspected can still be removed through `applyGrants`. | False (F8). Withdrawal uses the stored string as the boundary, without resolution. |
| Remove and narrow affect only the named root. | False (F3). The confirmation names the other roots, and the change refuses if that set changed. |
| A confirmation is needed only for narrowing changes. | False. Write-only to R both adds and withdraws, and a no-op can become a withdrawal. `expectedWithdrawn` is required for every `set-level` and `remove`. |
| The explicit level is the effective access. | False (F1). Rows show inherited read or write. |
| `covered-by-ancestor` reports remaining access after a removal. | False (F4). `stillReachable` is computed against the resolved request target. |
| "No folders" means agents read nothing. | False (F29). The empty-state text says that indexed content stays readable. |
| `outline` returns `access_denied`. | False (F21). Journey A asserts `isError` and the refusal text. |
| `npx playwright test` runs the changed handlers. | False (F31). The focused command is `npm run test:e2e -- <file>`. |
| A sender URL can be compared as a raw string. | False. The dev URL gains a trailing slash, and `file:` origins are all `"null"`. Section 4.2 defines the comparison. |
| Only a person in Settings can call the handlers. | False (F22). The sender check limits callers to the application page. The ADR records that page script is trusted, and why a widening confirmation is not added (F26). |
| Document content cannot run script in the page. | Partly confirmed (F27). It is not backed by a navigation guard or a Content Security Policy (F25). I did not test a hostile Mermaid diagram. |

## 9. Review record

Codex reviewed the requirements document (11 findings) and then this plan (11 findings) on 2026-11-01. The reviews are in this session's scratchpad, not in the repository.

- Requirements review: all 11 findings accepted. For the blocker on the trust model, the sender check and the ADR trust model were accepted. A native confirmation for R to RW was rejected, for the reason in section 4.6. A navigation guard, a Content Security Policy and file IPC path checks were deferred as separate hardening.
- Plan review: all 11 findings accepted. They changed the transaction (single resolution, withdrawal by stored name, a required affected set), remaining-access notices, the sender comparison, the outer tests (all three written first, the MCP assertion, the build command), the placement test, the contract check and several citations.

## 10. Out of scope

- Agent comments on Markdown tabs (`electron/agentRequestTargets.ts:64`).
- A write-only level in Settings (D1).
- Per-agent grants, deny rules, and changes to the record format or the CLI.
- Deleting indexed content when a folder is removed.
- A same-window navigation guard, a Content Security Policy and path checks for the existing file IPC (follow-up hardening, section 4.6).
- Showing the data directory path in the UI.

## 11. Implementation verification map

- `tests/e2e/folder-access-settings.spec.ts`: journeys A and B and sender boundary C through the real preload, handlers, filesystem and MCP process; rejected-first-load recovery through Retry; keyboard tooltips and guarded activation for unavailable choices; tooltip visibility above the Settings overlay and the Remove tooltip.
- `core/consent/folderAccess.test.ts`: explicit and inherited access, root inspection, planning, locked changes, affected-set checks, remaining access and real lock contention; unresolvable picked folders and inherited access for moved symlink targets.
- `electron/folderAccess.test.ts`: sender URLs and frames, input validation, native dialog outcomes and typed failures.
- `mcp/commentOperations.test.ts`: open-document refusal directs the person to Settings or the command line.
- `electron/folderAccessBoundary.test.ts`: agent modules cannot import grant writers.
- `electron/folderAccessContract.test.ts`: two-way assignability of core/main and renderer contracts, included in `typecheck:tests`.

Implementation deviations and the hidden-window test configuration are recorded in
[the implementation record](records/2026-11-01-folder-access-settings.md).
