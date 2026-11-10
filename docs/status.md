# Verification status

## Folder access settings, 2026-11-10

Validated for the user-authorized local merge from
`cwik-tech/folder-access-settings` into `main`. Git records the merge itself.
Code tested: `a50feec4d1fcc3b8ed33740e7066528e8b845b49`;
base: `a6151814d993ee3ca72b50d701f3eca9ece55777`.
Runtime: Node.js 22.22.2 on macOS arm64, matching CI's Node major version.
The documentation-only verification commit does not change the tested code.

| Check | Command | Observed result |
| --- | --- | --- |
| Production build and TypeScript | `heavy-run --label markpdf -- npm run build` | Exit 0. Renderer, core, CLI, MCP, test-source and Electron TypeScript checks passed; Vite built the renderer. Vite emitted its large-chunk advisory. |
| Full co-located suite | `heavy-run --label markpdf -- npm test` | Exit 0. 148 files and 1,707 tests passed in 53.60 seconds. |
| Full Electron suite | `heavy-run --label markpdf -- npm run test:e2e` | Exit 0. All 62 journeys passed in 3.4 minutes, including all five folder-access journeys. |
| Diff review | `git diff --check main...HEAD` and direct review of every changed file | No whitespace errors, accidental deletions or stray debug code found. |
| Lint | Unavailable | No lint script or checked-in ESLint configuration exists. |

### Static verification and its limits

Read-only Code-map inspection and verification ran through `heavy-run` in the
assigned checkout. Verification run `V-20261110T215739Z-fe6b3d42` compared the
base and tested code above using `static-baseline-v0`, with execution disabled.
It returned `INSUFFICIENT_EVIDENCE` (exit 3), not approval.

| Category | Code-map rating | Reason and direct verification |
| --- | --- | --- |
| Structural Integrity | 1/5 | Four new import findings refer exclusively to ignored generated `dist-core/consent/allowlistFile.js` and `dist-core/consent/folderAccess.js`. Both files exist after the required build; the compiler and runtime tests resolve them. They are intentionally absent from the committed snapshot, per `AGENTS.md`. No IPC pairing finding was reported. |
| Verification Coverage | Unassessed | No test report or LCOV was bound to Code-map. The executed suite results are recorded above; no changed-line coverage claim is made. |
| Behavioral Confidence | Unassessed | No bound reports or human oracle records were supplied. The static profile cannot establish acceptance. |
| Change Completeness | 2/5 | Consumer verification remains unknown in the static scan. Default roots omit core, CLI and MCP source, and the declaration file is outside its import checks. Direct review and the complete build and suites cover those boundaries separately. |

Code-map's missing evidence was not converted into a passing result. No
configuration, authorization, dependency or production code was changed for this
verification.

### Manual acceptance boundary

The folder-access journeys run hidden Electron windows with the real preload,
handlers, consent file and MCP server. Native picker and confirmation results are
substituted. Their native appearance and actual window-focus refresh remain
manually unverified. See the [implementation record](records/2026-11-01-folder-access-settings.md).
