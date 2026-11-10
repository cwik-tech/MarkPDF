# Verification status

## Markdown refresh, 2026-11-10

Verified in the working tree on `323356ec`, using Node.js 22.22.2 on macOS arm64.

| Check | Command or evidence | Observed result |
| --- | --- | --- |
| Build and TypeScript | `npm run build` | Passed, including the Electron compile. Vite emitted its existing large-chunk advisory. |
| Co-located tests | `npm test` | 148 files and 1,707 tests passed in 52.98 seconds. |
| Related Electron journeys | `npm run test:e2e -- "tests/e2e/markdown-.*\.spec\.ts" tests/e2e/open-document-context.spec.ts tests/e2e/mixed-document-search.spec.ts tests/e2e/cli-install.spec.ts` | 19 passed in 45.7 seconds, including all three refresh journeys. |
| Rendered toolbar | Isolated Electron window with a temporary Markdown file | Observed Refresh beside Sign and a 180° turn over 320 ms after reloading. Reduced motion disabled the transition. |
| Lint | Unavailable | No lint script or checked-in ESLint configuration. |

`tests/e2e/markdown-refresh.spec.ts` used the real file reader, preload, and
temporary files. The focused command was `playwright test tests/e2e/markdown-refresh.spec.ts`
with the local binaries on `PATH` and Electron compiled. With only the button
wired into the toolbar, the external edit stayed hidden, the missing file
raised no alert, and the search count stayed at 80 instead of 1. After
implementation and refactoring, all three journeys passed in 5.3 seconds.
A temporary change that cleared the preview on a read error failed the
missing-file journey; the restored implementation passed the related suite.

Read-only Code-map run `V-20261110T222025Z-cd50befa` returned
`INSUFFICIENT_EVIDENCE` with no failed or blocking checks. Structural Integrity
was 2/5 because consumer compatibility remained unknown to the static profile;
Change Completeness was 3/5 for the inspected change. Verification Coverage
and Behavioral Confidence were unassessed because no test or coverage reports
were bound and the profile cannot confirm acceptance criteria. The build and
Electron evidence above were observed separately.

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
