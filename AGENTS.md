# AGENTS.md

Instructions for AI coding agents and humans working in this repository.

## Test-Driven Development policy

Every behavior change and bug fix must follow **Red → Green → Refactor**.
The repository adopted this policy after evaluating it across backend, UI,
file-parser, Electron, and cross-layer work.

The policy does not require a new failing test for documentation-only edits,
formatting, dependency metadata, behavior-preserving refactors, or
presentational-only UI changes. Existing code does not need retrospective tests
unless the task changes that behavior.

Presentational-only UI work includes moving or rearranging existing components
without changing state, conditions, event handling, data flow, accessibility
behavior, focus, scrolling, navigation, persistence, or a renderer-to-API
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
| Backend or domain logic | `tests/unit/` |
| API, process, concurrency, or transport behavior | `tests/integration/` |
| React or UI behavior | `ui/src/**/__tests__/` |
| File parsing | `file-parser/tests/` |
| Electron user journey | `tests/electron/` |
| Real external provider | `tests/live/` |

Add an integration test to `isolatedTestBasenames` in `tests/run-tests.mjs`
only when it uses global resources, fixed ports, expensive processes, large
durable datasets, or timing-sensitive workloads. Integration tests do not
require isolation merely because they use a real transport.

Use the lowest layer that can observe the complete requirement. Add a real
Electron journey when behavior depends on layout, focus, scrolling, portals,
the `file://` renderer, persisted desktop state, navigation between tabs, or a
renderer-to-API boundary. Passing component tests alone does not close a
visible desktop regression.

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
  ownership relationships. Do not let duplicate display names make a test act
  on a different session, project, run, or file than the user journey intends.
- **Add relevant edge cases only.** Consider empty input, boundaries,
  concurrency, replay/idempotency, and owner/resource switches when the
  requirement makes them relevant.
- **Prefer realistic local I/O.** Use real temporary files, temporary
  directories, loopback servers, local processes, and local transports when
  those semantics are under test.
- **Replace external boundaries narrowly.** Unit tests may replace external
  networks or providers when necessary for speed and determinism. Real
  third-party APIs belong in opt-in live tests and must not make the normal
  suite credential-dependent.
- **Do not stop at a replaced boundary.** When a change spans UI state and a
  local API, pair the fast component test with an integration or Electron test
  using the real loopback API and filesystem stores.

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
  under `docs/`. Simple fixes and isolated behavior changes may use the user
  request, issue, or test as their specification.
- When a design document exists, its Verification section must name the tests
  that cover the documented decision.
- Every completed coding task must add or update `CHANGELOG.md`.
  Documentation-only reviews and scans do not require a changelog entry.

## Skill authoring policy

Every `SKILL.md` in this repository — in `skills/`, under `agents/*/skills/`,
and in `examples/` — follows the Agent Skills specification at
https://agentskills.io/specification. `tests/unit/skill-spec-conformance.test.ts`
enforces it, so a skill that breaks a rule fails `npm test`. The enforced
rules:

- **Frontmatter carries only the spec's keys**: `name` and `description` are
  required; `license`, `compatibility`, `metadata`, and `allowed-tools` are
  optional. Anything else is rejected.
- **`name` is 1-64 characters** of lowercase `a-z`, `0-9`, and single hyphens,
  with no leading hyphen, no trailing hyphen, and no consecutive `--`. It must
  be identical to the skill's folder name.
- **`description` is at most 1024 characters** and states both what the skill
  does and when to use it, with the trigger keywords an agent would match on.
  It is the only text loaded at startup, so it carries the whole activation
  decision. `Method for market sizing.` fails that job; `Size a market from
  the bottom up … Use when a business case needs a defensible TAM …` does it.
- **The body stays under 500 lines** and roughly under 5000 tokens, because it
  loads whole the moment the skill activates. Longer material goes in sibling
  `references/`, `scripts/`, or `assets/` folders, linked by relative path one
  level deep from `SKILL.md`.
- **A description containing `: ` must use a folded block scalar**
  (`description: >` with the text indented two spaces beneath) or the
  frontmatter will not parse as YAML.

The two generators that write skills carry these rules in their prompts:
`domains/agent-generator/agent-prompt.ts` for the live Agent Architect, and
`renderInferredSkill` in `domains/agent-generator/create-agent.ts` for the
offline fallback. `agents/resource-architect/resource-architect.md` carries
the naming half for the Agent and Team Architect. Change the rules in all
four places, or not at all.

## UI styling policy

Full guide: `docs/UI-Styling-Guide.md`. The enforced rules:

- **Use a shadcn primitive before writing markup.** They live in
  `ui/src/components/ui/`. `Button` not `<button>`, `Card` not a bordered div,
  `PanelEmptyState` not a dashed box, `Tabs` not a hand-rolled tab strip,
  `FieldHelp` not a hand-rolled "i" tooltip. Anything clickable is a `Button`,
  including selectable rows and sidebar entries — reshape it with `h-auto`,
  `justify-start`, and `font-normal`. A raw `<button>` is correct only inside
  `ui/src/components/ui/`, where a primitive implements its own root element.
  If a primitive lacks a variant you need, add it to the primitive rather than
  forking markup at the call site.
- **No raw pixel values in class names.** Radius, type, spacing, and sizing all
  come from theme tokens. `rounded-lg` not `rounded-[8px]`, `text-xs` not
  `text-[11px]`, `w-75` not `w-[300px]`, `size-4.5` not `size-[18px]`.
- **No raw colours.** Semantic tokens only — `bg-card`, `text-muted-foreground`,
  `bg-surface-sunken`.
- **Tokens change in one place**, `ui/src/index.css`, declared under `:root`
  and `.dark` and mapped in the `@theme` block.

Four exceptions are documented in the guide: vendored shadcn primitive source,
runtime-measured values, values computed from data, and viewport clamps. Nothing
else may carry a pixel value.

These checks must print nothing:

```sh
grep -rn "<button" ui/src --include="*.tsx" --exclude-dir=__tests__ --exclude-dir=ui
grep -rnE "[a-zA-Z-]+-\[-?[0-9.]+px\]" ui/src --include="*.tsx" --include="*.ts"
```

## Verification commands

| Scope | Required command |
|-------|------------------|
| Backend unit suite | `npm run test:unit` |
| Backend integration suite | `npm run test:integration` |
| Backend TypeScript | `npx tsc --noEmit` |
| UI tests | `npm --prefix ui run test` |
| UI lint, tests, and build check | `npm --prefix ui run check` |
| File-parser tests | `npm --prefix file-parser test` |
| File-parser build/typecheck | `npm --prefix file-parser run build` |
| Core, architecture, UI, and file-parser | `npm test` |

During the TDD loop, run the narrowest relevant command. Do not run `npm test`
after every small edit; run the full gate after the focused suite and relevant
layer checks are stable. Before merging the worktree, run `npm test`,
`npx tsc --noEmit`, and any applicable Electron or opt-in live verification
required by the changed behavior. After a visible Electron change, verify the
actual user journey rather than relying only on build output or DOM assertions.

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
- [ ] `npx tsc --noEmit` is green for backend TypeScript changes.
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
