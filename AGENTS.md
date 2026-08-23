# AGENTS.md

Instructions for AI coding agents and humans working in this repository.

## Repository architecture

MarkPDF is one npm package with four runtime boundaries:

- `electron/bootstrap.ts` captures operating-system file-open events before the
  main process finishes loading.
- `electron/main.ts` owns Electron lifecycle, windows, filesystem access,
  persisted settings, native dialogs, subprocesses, and IPC handlers. Supporting
  main-process modules live beside it in `electron/`.
- `electron/preload.ts` is the renderer's only bridge to privileged Electron
  capabilities. Its public TypeScript contract is mirrored in `src/global.d.ts`.
- `core/` is pure Node.js. It has no imports from `electron`, no DOM types, and runs
  under plain `node`. It owns chunking, embeddings, the SQLite semantic index,
  search, document reading, OCR, the consent model, and the output bounds. It is
  compiled by `tsconfig.core.json` to `dist-core/`, and `electron/`, `cli/` and `mcp/`
  are its callers — through `dist-core/`, never through `core/` sources.
- `cli/` is the `markpdf` command. It parses arguments, calls core, and formats
  output; it holds no document logic. It is compiled by `tsconfig.cli.json` to
  `dist-cli/`, imports core through `dist-core/`, and runs on the Electron binary
  under `ELECTRON_RUN_AS_NODE=1`.
- `mcp/` is the Model Context Protocol server: four tools over stdio for an agent,
  built on the official SDK. It validates tool arguments, calls core, and formats
  JSON replies; like `cli/` it holds no document logic, and it generates its tool
  schemas from the command table in `cli/spec.ts` rather than describing the same
  arguments a second time. It is compiled by `tsconfig.mcp.json` to `dist-mcp/`,
  imports core and the command table through `dist-core/` and `dist-cli/`, and runs
  the same way the command does. **stdout belongs to the protocol** — every
  diagnostic goes to stderr, and a refused tool call is an answer inside the
  protocol, not a message on the error stream.
- `src/` is the React renderer. `src/App.tsx` coordinates the document UI;
  reusable document, conversion, Markdown, and OCR logic lives in focused modules
  under `src/`.

Anything a tool returns is bounded before it leaves the process, and both bounds live
in `core/output/budget.ts` rather than in a transport: a content bound on how much
document text an operation gathers, and a reply bound on the finished JSON. They are
separate because serialization cost depends on the content — escaping and per-item
keys — so one cannot stand in for the other.

Keep privileged input/output in `electron/`. Renderer code must use
`window.pdfReader`; it must not import Electron or Node APIs, and it must not import
`core/` or `dist-core/`. Shared types cross through `src/global.d.ts` like any other
IPC contract. `core/boundaries.test.ts` enforces both directions. When an IPC method
changes, update the handler in `electron/main.ts`, the bridge in
`electron/preload.ts`, and the declaration in `src/global.d.ts` together. Treat
IPC arguments, files, provider responses, subprocess output, persisted values,
and model output as external input and validate them at the receiving boundary.

The compiled directories `dist/`, `dist-electron/`, `dist-core/`, `dist-cli/`, and
`dist-mcp/` are build output. Never edit them by hand. `dist-core/` must be built
before `electron/`, `cli/` or `mcp/` typechecks or runs, and `dist-cli/` before
`mcp/` does; `npm run build:core`, `npm run build:cli`, `npm run build:mcp` and the
`pretest` hook do this.

`core/`, `cli/` and `mcp/` are directories inside this single npm package, not separate
npm packages.
This repository has no npm workspaces, no separate backend, no UI package, no
file-parser package, no skill system, and no architecture-check command.

## Test-Driven Development policy

Every behavior change and bug fix must follow **Red → Green → Refactor**.
Apply it to renderer logic, document processing, Electron behavior, and
cross-boundary work.

The policy does not require a new failing test for documentation-only edits,
formatting, dependency metadata, behavior-preserving refactors, or
presentational-only UI changes. Existing code does not need retrospective tests
unless the task changes that behavior.

Presentational-only UI work includes moving or rearranging existing components
without changing state, conditions, event handling, data flow, accessibility
behavior, focus, scrolling, navigation, persistence, or the preload/IPC
boundary. It also includes spacing, color, copy, class names, and icon swaps.
Do not add a new test or mutation proof for this work. In particular, do not
write a test that asserts only markup position, CSS classes, or visual
structure. Use the existing build checks and inspect the rendered result when
that provides useful verification.

## Choose the loop shape

A test loop protects one observable contract. Choose its outer boundary from
the behavior and risk, not from the size of the code change. An outer test is
not automatically an Electron test.

| Work | Required approach |
|------|-------------------|
| New cross-layer user capability | Start with an acceptance test at the highest sensible boundary. Use focused inner loops for the rules and boundaries needed to make it pass. |
| New single-layer behavior | Start at that layer's public boundary. Add lower tests only where they express important rules more clearly. |
| Bug fix | Write the lowest-layer regression test that reproduces the complete failure. Use Electron only when the failure depends on desktop behavior. |
| Behavior-changing refactor | Treat the changed contract as new behavior and establish Red before changing it. |
| Behavior-preserving refactor | Begin with the relevant existing tests Green and keep them Green. Add a characterization test only when the public behavior lacks protection. Do not manufacture Red evidence. |
| Presentational-only UI change | Add no test. Run build checks and inspect the result as described above. |

## Red, Green, Refactor

1. **Red.** Derive one externally observable behavior from the requirement,
   write the test in the repository's native test suite, and run it before the
   implementation. Confirm that it fails for the expected reason.
   - An assertion failure is preferred.
   - For a genuinely new interface, an initial missing-export or type failure
     is acceptable. Add only the minimum interface shape, then establish a
     behavioral failure before completing the implementation.
   - Record the test file, command, expected failure, and why the failure
     represents the requested behavior.
   - If the test passes before implementation, inspect the assertion, fixture,
     and chosen test layer. A test that never observed the missing behavior is
     not Red evidence.
2. **Green.** Write the minimum implementation that makes the new test pass.
   Do not add unrelated features or speculative abstractions.
3. **Refactor.** Improve naming and structure while the test remains green.
   Re-run the targeted test after each meaningful refactor.

### Double-loop TDD for cross-layer features

Split a large feature into independently useful vertical capabilities. Each
capability gets its own outer acceptance loop. Do not keep one permanently
failing test around an entire feature while unrelated production work piles up.

A large feature may have several substantial E2E tests. Use separate tests for
distinct user outcomes, such as the main journey, reload or recovery,
cancellation or failure, or genuinely different execution modes. There is no
fixed number. An E2E test may cross the whole application and take many steps,
but it must remain one coherent user journey.

Do not make an E2E test prove every rule it happens to pass through. Exact file
formats, generated identifiers, rollback branches, validation matrices, CSS
classes, and internal call sequences belong at lower layers unless the user can
observe them as part of the acceptance contract. Avoid repeating a lower-level
test matrix in E2E.

For each vertical capability:

1. Write and run the outer acceptance test Red at the highest sensible layer.
2. Drive the next required rule or boundary through the smallest useful unit,
   integration, or component Red → Green → Refactor loop.
3. Repeat inner loops until the outer test goes Green.
4. Refactor while the focused inner tests and outer test remain Green.
5. Run the affected layer gates before starting the next capability.

The first capability should usually be a thin working journey through the real
stack. Once it is Green, add the next user outcome with a new outer Red instead
of widening the first test indefinitely.

## Choose the correct test layer

| Change | Test location |
|--------|---------------|
| Pure renderer, document, conversion, or parsing logic | Co-located `src/**/*.test.ts` using Vitest |
| Pure Node core logic: store, chunking, embeddings, search, reading, OCR, consent | Co-located `core/**/*.test.ts` using Vitest |
| Command line argument handling, exit codes, and output shape | Co-located `cli/**/*.test.ts` using Vitest |
| MCP tool schemas, argument validation, access classes, and reply bounds | Co-located `mcp/**/*.test.ts` using Vitest, plus a stdio journey under `mcp/journeys/` driving the official SDK client against the real server process |
| React behavior that can be expressed through an extracted pure rule | Co-located `src/**/*.test.ts` using Vitest |
| Electron lifecycle, preload/IPC, filesystem, window, or complete UI behavior | `tests/e2e/*.spec.ts` using Playwright's Electron support |
| Real external provider or managed tool | An explicit opt-in test or manual check that is excluded from the default suite. The embedding model is covered by `npm run test:live`; the default suite substitutes a deterministic embedder and the reason is documented in `core/index/embeddings.live.test.ts` |

The Vitest configuration includes `src/**/*.test.ts`, `core/**/*.test.ts`,
`cli/**/*.test.ts`, and `mcp/**/*.test.ts`, and excludes `**/*.live.test.ts`, which
run through `npm run test:live`. It does not configure a browser DOM environment.
Do not assume a browser component-test harness or an Electron integration-test
harness exists.
Adding a new harness or dependency requires approval.

Use the lowest layer that can observe the complete requirement. Add a real
Electron journey when behavior depends on layout, focus, scrolling, the
`file://` renderer, persisted desktop state, native dialogs, window lifecycle,
navigation between tabs, or the preload/IPC boundary. Passing a pure renderer
test alone does not close a visible desktop regression.

## Test design rules

- **Tests are the specification.** Derive them from the user request, issue,
  user story, or design document rather than from the implementation.
- **Use an independent expected result.** Use a requirement, worked example,
  known literal, or trusted fixture. Do not calculate the expected value with
  the same algorithm as production code.
- **One observable contract per test.** Use a sentence-style name that states
  the outcome. A substantial E2E test may contain many steps and assertions
  when they all prove one coherent user journey.
- **Arrange / Act / Assert.** Keep the phases visually distinct where useful.
- **Use readable factories.** Prefer a `make*` helper with valid defaults when
  a test needs structured input.
- **Use stable identities.** Address resources by durable IDs or exact
  document relationships. Do not let duplicate display names make a test act
  on a different tab, document, provider, or file than the user journey
  intends.
- **Add relevant edge cases only.** Consider empty input, boundaries,
  concurrency, replay/idempotency, and active-document or engine switches when
  the requirement makes them relevant.
- **Prefer realistic local I/O.** Use real temporary files, temporary
  directories, loopback servers, local processes, and local transports when
  those semantics are under test.
- **Replace external boundaries narrowly.** Unit tests may replace external
  networks or providers when necessary for speed and determinism. Real
  third-party APIs belong in opt-in live tests and must not make the normal
  suite credential-dependent.
- **Do not stop at a replaced boundary.** When a change spans renderer state and
  preload/IPC, pair focused tests of pure rules with an Electron test using the
  real preload bridge and filesystem behavior.

## Verify that the test protects the behavior

The initial Red run is the primary proof that a test protects new behavior.
Add a temporary implementation mutation for each high-risk behavior cluster,
or when the test could plausibly pass through the wrong path. This is expected
for:

- persistence, caching, ownership, recovery, concurrency, and security rules;
- regressions that previously survived tests;
- cross-layer flows with substituted boundaries; and
- fixes where several UI regions can display similar state.

Mutation proof is optional for isolated accessibility labels and other low-risk
behavior when the initial Red failure directly demonstrates the requested
contract. When mutating, change or remove the implementation behavior, confirm
the test fails, restore it, and rerun the test. Do not flip the test assertion:
that proves only that the test runner can report a failure.

Mutation-testing tools are not mandatory until the repository provides an
installed dependency, configuration, and documented command. Introducing one
is a separate testing decision.

## Failure and skip policy

- Do not use unconditional `.skip`, `todo`, commented assertions, or weakened
  expectations to hide unfinished behavior.
- Conditional runtime skips are allowed only for documented environmental
  prerequisites such as an unavailable browser, OS capability, or credential.
- A required test must run in its declared CI environment. An environmental
  skip is not a substitute for implementing required behavior.
- Pre-existing failures must be reported and kept separate from failures
  introduced by the current change.

### When a meaningful Red test is impractical

Do not add a brittle, mock-heavy, or implementation-coupled test only to satisfy
this policy. If no native test layer can express the behavior without
production-only state, a paid or rate-limited dependency, unstable third-party
infrastructure, or disproportionate unrelated setup:

1. Explain the limitation before editing production code.
2. Ask the user to approve the exception.
3. Use the closest executable check, such as a focused script, browser journey,
   live test, or manual reproduction.
4. Report that the check is verification, not Red evidence.

A failure first observed in a release gate may serve as Red evidence for a
narrowly scoped test-harness correction. Add a focused regression test before
fixing the harness, record the original gate failure, and keep product behavior
out of that correction.

## Documentation policy

- Substantial architectural decisions require an Architecture Decision Record
  under `docs/adr/` using `YYYY-MM-DD-Short-Name.md`. Simple fixes and isolated
  behavior changes may use the user request, issue, or test as their
  specification.
- When a design document exists, its Verification section must name the tests
  that cover the documented decision.
- Every completed coding task must add or update `CHANGELOG.md`.
  Documentation-only reviews and scans do not require a changelog entry.

## UI styling policy

The renderer uses React components and the global stylesheet in
`src/styles.css`; it does not use Tailwind or shadcn. Reuse existing component
and class patterns before adding another styling approach. Keep document and
view calculations in TypeScript when they depend on runtime PDF geometry; keep
static presentation in CSS. Presentational-only work follows the test exemption
above and still requires inspection of the rendered Electron UI when practical.

## Verification commands

| Scope | Required command |
|-------|------------------|
| Focused Vitest file | `npm test -- src/path/to/file.test.ts` |
| All co-located Vitest tests | `npm test` |
| Renderer TypeScript | `npm run typecheck` |
| Core TypeScript | `npm run typecheck:core` |
| Command line TypeScript | `npm run typecheck:cli` |
| MCP server TypeScript | `npm run typecheck:mcp` |
| Test-source TypeScript | `npm run typecheck:tests` |
| Electron main and preload TypeScript | `npx tsc -p tsconfig.electron.json --noEmit` |
| Renderer and Electron build | `npm run build` |
| Focused Electron journey | `npx playwright test tests/e2e/name.spec.ts` |
| All Electron journeys | `npm run test:e2e` |

During the TDD loop, run the narrowest relevant command. Do not run every gate
after each small edit. Before merging the worktree, run `npm test`, `npm run
build`, and any applicable Electron or opt-in external verification required by
the changed behavior. After a visible Electron change, verify the actual user
journey rather than relying only on build output or DOM assertions.

There is currently no lint script or checked-in ESLint configuration. Do not
claim that lint passed. Report it as unavailable until a separate approved task
adds lint tooling.

## Working with an LLM agent

For repository-based analysis and implementation plans, cite `file:line` for
every load-bearing claim about existing behavior. Mark unsupported claims as
**unverified**. Before presenting an implementation-ready plan, perform a
falsification pass: actively inspect evidence that could disprove its key
assumptions and revise or qualify the plan accordingly.

For a behavior change, use this order:

1. Classify the work using "Choose the loop shape" and state the observable
   acceptance criterion.
2. Select the highest sensible outer boundary. For cross-layer work, name the
   vertical capability and the coherent user journey before writing the test.
3. Add the required outer or focused test, run it Red, and report the evidence.
4. For cross-layer work, complete the necessary inner loops one at a time. For
   single-layer work, implement the minimum focused Green change.
5. Run the outer test Green before starting another vertical capability.
6. For high-risk behavior, prove the test bites with an implementation
   mutation. Then refactor and run the relevant verification gates.
7. Report the outer test or focused test, Red failure, inner-loop results when
   applicable, final Green result, and verification commands in the delivery.

For a behavior-preserving refactor or presentational-only UI change, follow the
corresponding row in "Choose the loop shape." Do not invent a failing test to
fit the behavior-change workflow.

If implementation was written before its test, stop. Revert only the agent's
uncommitted implementation, write and run the test, and then resume the loop.
Never discard unrelated user changes.

## Definition of done for a behavior change

- [ ] One requirement-derived outer or focused test was written before
      implementation.
- [ ] The outer or focused test was run and failed for the expected reason.
- [ ] Cross-layer work used focused inner loops where they clarified a rule or
      boundary, and its outer test went Green.
- [ ] The minimum implementation made the targeted test pass.
- [ ] Each E2E test proves one coherent user outcome and leaves internal rule
      matrices to lower layers.
- [ ] High-risk behavior received mutation proof, or the initial Red failure
      directly proved the low-risk contract.
- [ ] Refactoring kept the targeted test green.
- [ ] Relevant layer-specific verification is green.
- [ ] Visible desktop behavior was exercised in Electron when applicable.
- [ ] `npm run typecheck` is green for renderer TypeScript changes.
- [ ] `npx tsc -p tsconfig.electron.json --noEmit` is green for Electron
      TypeScript changes.
- [ ] Lint passed, or the delivery explicitly reports that this repository has
      no configured lint command.
- [ ] No unfinished behavior is hidden by skips, todos, or weak assertions.
- [ ] Any applicable design document names the verification tests.
- [ ] `CHANGELOG.md` records the completed coding task.

## Policy maintenance

For substantial changes, record:

- which behaviors completed genuine Red → Green → Refactor cycles;
- defects or design problems discovered by writing tests first;
- focused-loop runtime separately from full-suite runtime;
- test flakiness, fixture ambiguity, harness defects, and maintenance cost;
- cases where compile-first failures or replaced boundaries were necessary;
- instructions that caused unnecessary friction or low-value tests.

Keep TDD policy changes separate from feature implementation. If the policy
causes repeated low-value tests or blocks a meaningful verification path,
propose a focused policy change instead of weakening the current task's tests.
