# PRD: Folder access in Settings > General

Status: decisions recorded (section 10). Revised after the Codex reviews of the requirements and the plan, 2026-11-01. Date: 2026-11-01.
Implementation plan: `docs/folder-access-settings-plan.md`.
Evidence is cited as `file:line`. Claims without a citation are marked **unverified**.

## 1. Problem and context

Context from the conversation: an agent called the MCP tool `suggest_annotation` and was refused ("this tool is not permitted to read its file"). The user believed the folder was granted. The grant file held only `readRoots: ["/Users/tomasz/Downloads"]`, and the open document was not inside that folder. `suggest_annotation` needs a read grant and an open document (`mcp/evidenceOperations.ts:140-162`). The refusal comes from the failed read check (`core/agent/documentTarget.ts:76-84`). A write grant was not the missing part.

Nothing in the app shows the grant list. Today the only way to change a grant is the command line: `--allow-read`, `--allow-write`, `--revoke-read`, `--revoke-write` (`cli/spec.ts:106-133`).

User request: "In the General tab, list the permitted access folders. For each folder there should be a simple control to choose read, write, or read and write. It could be three buttons in a button group." The user later removed the write-only choice (decision D1).

## 2. Facts this design relies on

- The model keeps `readRoots` and `writeRoots` as separate lists. Neither implies the other (`core/consent/allowlist.ts:23-26`, `:120-123`). Effective access to a path is the union of every containing root, separately for read and for write (`core/consent/allowlist.ts:114-130`).
- A row's buttons show its **explicit** level, that is, the lists that hold this exact root. R is "in `readRoots` only". RW is "in both lists". The command line can also make a root that is "in `writeRoots` only" (`--allow-write`). Settings does not offer that level (D1), but it must show such a row correctly.
- **Effective access can be wider than the explicit level.** A child root with R can still be writable through an RW parent. The row must say so.
- Roots are canonical absolute paths, resolved once at grant time. `applyGrants` resolves every input path again before it stores it (`core/consent/allowlistFile.ts:112-119`). Thus an "allow" on a stored name whose folder was later replaced by a link would store the link's target. The access check deliberately never re-resolves a stored root, for this reason (`core/consent/allowlist.ts:15-21`).
- **A withdrawal reaches downwards.** Revoking a root also removes every stored root inside it, for that access kind (`core/consent/allowlistFile.ts:94-106`, `:123-131`, test at `core/consent/allowlistFile.test.ts:118-125`). Settings keeps this rule and tells the person which other folders it affects.
- `covered-by-ancestor` is reported only when a withdrawal removes nothing (`core/consent/allowlistFile.ts:125-141`). Thus the remaining access after a successful removal must be computed from the new record, not from that result.
- A root can be a file as well as a folder (`core/consent/allowlist.ts:37-40`).
- A missing record is the empty list. An unreadable record, invalid JSON, wrong field shapes and relative roots throw `AllowlistFileError` (`core/consent/allowlistFile.ts:147-197`, tests at `core/consent/allowlistFile.test.ts:451-481`).
- `updateAllowlist` takes the lock, reads, applies unconditional grants and writes (`core/consent/allowlistFile.ts:346-354`). It cannot check, under the same lock, that a row still exists. `withAllowlistLock` is the exported primitive for other consent changes (`:356-370`). It must not be nested, because the lock is exclusive and fails fast (`:292-303`).
- An abandoned lock is never taken over automatically. `AllowlistLockedError.recoverCommand` holds a command that removes only the lock file (`core/consent/allowlistFile.ts:20-45`).
- The MCP server reads the grants on each tool call (`mcp/context.ts:134`). The desktop reads them on each agent request (`electron/agentRequests.ts:209-213`). A running CLI command keeps the snapshot it read at its start (`cli/run.ts:73-76`, `cli/context.ts:80`).
- `read_pages` and `search` read the index and need no filesystem grant (`mcp/operations.ts:482-493`, `docs/adr/2026-08-23-MCP-Server-Adapter.md:75-85`). Thus removing every folder does not stop an agent from reading content that is already indexed.
- Settings has pages General, AI Providers and CLI & MCP (`src/AISettings.tsx:72-74`). General renders `GeneralSettingsPage` (`src/AISettings.tsx:524`, `:661`) and has no grant UI today.
- The desktop data directory is `app.getPath("userData")` (`electron/main.ts:134`). The core default for the command line and the MCP server is `~/Library/Application Support/markpdf` (`core/paths.ts:13`, `:28`). On the development Mac, that folder holds the desktop's own files and `consent/allowlist.json`, so the two are the same in the default setup. `MARKPDF_DATA_DIR` (`electron/main.ts:126`) or the CLI `--data-dir` can make them differ.
- The bridge is exposed to all page script in every window, including agent windows (`electron/preload.ts:59-60`, `electron/main.ts:364`). The renderer can already read any path and write any path through IPC (`electron/main.ts:661-708`, for example `file:write-markdown`). New windows are denied (`electron/main.ts:383-386`), but no same-window navigation guard exists and `index.html` has no Content Security Policy.

## 3. Users and scope

User: one person on macOS who connects an agent through MCP or the `markpdf` command and wants to see and control which folders the agent may read or write.

Must have (v1):
- See the list of granted folders with their explicit level and any wider inherited access.
- Change the level of a folder with a two-button group: R and RW.
- Add a folder from a native picker (D3).
- Remove a folder, after a confirmation (D3, D5).

## 4. User stories and acceptance criteria

US-1 See the list.
- Given grants exist, when I open Settings > General, then I see each stored root once, with its full path and its explicit level, R or RW.
- A root only in `writeRoots` shows "Write only, set by the command line" and no pressed button.
- When a containing root gives wider access, the row says so and names that root, separately for read and write. For example: "Also writable through /Users/me/Projects".
- A root that is missing from disk shows "Not found". A root that cannot be checked shows "Cannot check". A file root is shown as a file, never as its parent folder.
- With no grants, the page says: "No folders are granted for direct file access in this MarkPDF data directory. Agents can still search and read documents that are already indexed."
- A damaged record shows the error and no controls. It never shows an empty list.

US-2 Change a level.
- Given a row with R, when I choose RW, then the root is in both lists, and the next MCP call can write under it.
- Choosing R on an RW row removes write access from this root and from every stored root inside it. If other rows are affected, a confirmation names them first.
- Choosing R or RW on a write-only row replaces that level.
- Widening is refused for a root that is missing, that cannot be checked, or that now resolves to a different place (for example, the folder was replaced by a link). The message says to remove the folder and add it again. Narrowing and removing such a root still work. Choosing R on a write-only row adds read, so it counts as widening.
- The choice is saved at once, without a Save button. While saving, the row's controls are disabled. On failure the row keeps its saved level and shows the message.
- The buttons show the letters R and RW (D2). Each has a tooltip and the accessible name "Read" or "Read and write". At most one is pressed, and the group works with the keyboard.

US-3 Add a folder.
- When I choose "Add folder", the main process opens a native folder picker. I pick a folder. It appears as a new row with the level R (D4).
- If the exact folder is already a stored root, nothing is duplicated and its level does not change. A folder inside a granted folder is a new root, and its row shows the wider inherited access.
- Cancelling the picker changes nothing.

US-4 Remove a folder.
- When I remove a row, a confirmation is shown first (D5). It names the folder and every stored root inside it that also loses access.
- When I confirm, read and write access end for that root and for the roots inside it. When I cancel, nothing changes.
- If a containing root still reaches the removed folder, a notice says so, separately for read and for write, and names that root. For example: "Agents can still read it through <parent>." If MarkPDF cannot check, the notice says that.

US-5 Changes reach agents.
- After a change, the next MCP tool call, the next desktop agent request and the next `markpdf` command that uses this data directory see the new grants. An operation that is already running is not cancelled.

## 5. Interface (summary)

Four fixed-purpose methods on `window.pdfReader.folderAccess`: `list()`, `setLevel(path, level)`, `add()`, `remove(path)`. The handler is in the main process, the bridge in `electron/preload.ts` and the declaration in `src/global.d.ts`, changed together (`AGENTS.md`). The detailed contract is in the implementation plan, section 4.

Rules:
- `level` is `"read"` or `"read-write"` only.
- `setLevel` and `remove` act only on a path that exactly equals a stored root. The check and the change happen under one hold of the consent lock.
- Only `add()` can create a new root, and its path comes from the native picker in main.
- A widening change never stores a path other than the stored root itself.
- Main accepts a call only from the main frame of a MarkPDF window that shows the application page. It refuses a call from any other page or frame.
- Each failure has a narrow reason: damaged record, lock busy, lock abandoned (with the recovery command shown, never run), row changed, root missing or moved, invalid input, or untrusted sender.

## 6. Security and ADR

`docs/adr/2026-08-23-MCP-Server-Adapter.md:67-70` says: "Consent is given out of band, with the command line", and that a server able to widen its own access would make the allowlist decorative. **A new ADR is required** under `docs/adr/`. It amends that decision: consent is given out of band, by the command line or by the desktop Settings page. It must state the trust model:

- No MCP tool, `markpdf` agent command or desktop agent request (reveal, suggest, prepare in `electron/agentRequests.ts`, `electron/agentPreparation.ts`) can reach the grant handlers. A boundary test enforces the import rule. The sender check enforces the runtime rule.
- The handlers trust the application's own page script. They do not prove that a person clicked. A script running in the application page can call them, as it can already call `file:write-markdown`.
- Document content must not run script or navigate the window. Today this rests on React rendering of Markdown, Mermaid strict mode with DOMPurify, filtered PDF links and the new-window handler. It does not rest on a navigation guard or a Content Security Policy, because neither exists.
- A navigation guard, a Content Security Policy and path checks on the file IPC are separate hardening work. They are not part of this feature.

## 7. Edge cases

| Case | Expected behavior |
|---|---|
| Nested roots | One row for each stored root. A row shows inherited read and write separately, with the covering root. Narrowing or removing a parent also changes the roots inside it, after a confirmation that names them. |
| Root missing from disk | "Not found". Narrowing and removing work. Widening is refused. The row is not deleted automatically. |
| Root replaced by a link, or an ancestor changed | Widening is refused with "remove and add it again". Narrowing and removing work by the stored name. |
| Root that cannot be checked (for example, a link to itself) | "Cannot check this folder". Narrowing and removing work by the stored name. Widening is refused. |
| The folder changes on disk during a change | The change resolves each path once and writes exactly what it planned. The consent lock protects the record, not the folder on disk. |
| File root | Shown as a file. Never converted to its parent folder. |
| CLI changes the record while Settings is open | The page reloads the list when the window gains focus and after each action. If a row no longer exists when the person acts, the action fails with "This folder changed. The list is refreshed." It never restores a root that the CLI removed. |
| Lock busy | "Another MarkPDF process is changing permissions. Try again." Row unchanged. |
| Lock abandoned | The message shows the recovery command from `AllowlistLockedError.recoverCommand`. The app does not run it. |
| Damaged record | Error, no controls, no write. |
| Write-only root from the command line | "Write only, set by the command line", no pressed button. R or RW replaces it. |

## 8. Out of scope

- Agent suggestions on Markdown tabs (`electron/agentRequestTargets.ts:64` filters `entry.kind === "pdf"`).
- A write-only level in Settings (D1).
- Deny rules, per-subfolder exceptions, per-agent grants, and changes to the record format or the CLI.
- Deleting indexed content when a folder is removed.
- A navigation guard, a Content Security Policy and path checks for the existing file IPC.
- Windows and Linux behavior of the picker (**unverified**).

## 9. Success criteria

A person can answer "Which folders can agents read or write in this data directory?" from the app alone. A "not permitted to read" refusal can be fixed without the command line.

## 10. Decisions

The user made these decisions on 2026-11-01:

- D1. No write-only level. Settings offers R and RW only.
- D2. The buttons show the letters R and RW, with tooltips.
- D3. Add and remove are in scope for v1.
- D4. A newly added folder gets the level R.
- D5. Removing a folder asks for confirmation.
- D6. Resolved by a code check: the desktop `userData` directory and the default data directory of the MCP server are the same folder in the default setup (section 2).
