# Core Node boundary

## Status

Accepted

## Context

MarkPDF's document processing lived entirely in the Chromium renderer. Text extraction, OCR,
chunking, embeddings and the vector store all depended on browser APIs — `crypto.subtle`,
canvas rasterisation, WebAssembly loaded from `import.meta.env.BASE_URL`, and
`window.pdfReader` IPC bridges. Two consequences followed. None of that logic could be tested
without a browser, and no other process could reach it, which put a command line surface and an
MCP server out of reach.

`AGENTS.md` described the repository as one npm package with three runtime boundaries and
stated that it has no separate packages. The strategy document proposed npm workspaces, which
would have contradicted both.

## Decision

Extract the processing core into a `core/` directory that is a sibling of `electron/` and
`src/`, compiled by `tsconfig.core.json` to `dist-core/`. It stays inside the single npm
package; there are no workspaces and nothing is published to npm.

Everything outside `core/` imports it through `dist-core/`. `core/` must not import Electron,
React, or anything under `src/`, and the renderer must not import `core/`.

The boundary is enforced two ways rather than by convention. `tsconfig.core.json` omits `"DOM"`
from `lib`, so `document`, `window`, `caches` and `import.meta.env` fail to compile inside
`core/`. And `core/boundaries.test.ts` scans production sources in both directions for
forbidden imports and browser globals.

## Consequences

- Core logic is unit-testable under plain `node` for the first time. The full
  parse-index-search cycle now runs with `window` and `document` undefined.
- `AGENTS.md` needs a matching amendment describing the fourth boundary.
- Node ESM authoring rules apply inside `core/`: every relative import carries an explicit
  `.js` extension.
- `dist-core` must be built before `electron/` typechecks or runs, because it is consumed as
  compiled output with declarations rather than as TypeScript sources. `pretest` and the build
  script handle this.
- Promoting to npm workspaces later remains mechanical, and is warranted only when a package
  must be published independently of the desktop release.

## Alternatives considered

- **npm workspaces**, as the strategy document proposed. Verified to work with
  electron-builder, which realpaths symlinked packages before copying. Rejected because it
  forces a full lockfile regeneration and adds a symlink-resolution step to the signed,
  notarised release path during the same change that introduces a native module. The isolation
  argument for it also fails: npm hoists dependencies to the root, so a package split would not
  stop the renderer importing `better-sqlite3` anyway.
- **`src/core/`.** Rejected because `tsconfig.json` includes all of `src` with DOM libs, so the
  compile-time boundary — the thing that actually enforces the rule — would be lost.
- **Leaving the logic in the renderer.** Rejected: it is the reason none of it is testable and
  the reason no second surface can exist.

## Verification

`core/boundaries.test.ts` (four contracts, both directions), `core/paths.test.ts`,
`core/index/pipeline.test.ts` for the no-browser cycle, and `npm run typecheck:core`.
