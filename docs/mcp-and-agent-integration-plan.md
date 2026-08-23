# MarkPDF — Model Context Protocol (MCP) & Agent Integration Plan

**Status:** Proposed
**Date:** 2026-08-23
**Owner:** Tomasz
**Audience:** implementing agent / developer working in the MarkPDF repository

---

## 0. How to read this document

This is a **strategy and architecture document, not an implementation specification**. It states what we are building, why, in what order, and which decisions are already made. It deliberately does not prescribe function signatures, file-by-file diffs, or test names — the implementing agent should derive those.

Where this document asserts a fact about the current codebase, that fact was verified against the source. Section 11 maps every claim to the file that proves it, so the implementing agent can re-verify rather than trust.

Terms are defined on first use. A glossary is in Section 12.

---

## 1. The thesis

MarkPDF currently ships a complete Artificial Intelligence (AI) provider layer — encrypted key storage, model discovery, and Command Line Interface (CLI) agent detection — that powers exactly one feature: semantic search. That layer is maintained weight with no return.

At the same time, MarkPDF has quietly built three things that are individually valuable and collectively rare:

1. A local, automatic Optical Character Recognition (OCR) path that only fires when a Portable Document Format (PDF) file genuinely lacks a text layer.
2. A local embedding index with **page-anchored** chunks — every search hit knows which page it came from.
3. A multi-engine Markdown (MD) conversion layer with an automatic engine router.

None of these are reachable by anything except MarkPDF's own user interface (UI).

**The thesis of this plan:** expose that capability through a shell surface and MCP, and MarkPDF stops being "another PDF reader" and becomes a *local document substrate that any agent can query and cite*. The reader UI becomes one client of the core rather than its owner.

The one-line goal:

> Any document on my disk is a queryable, citable knowledge source for any agent I own — locally, without the file leaving the machine.

---

## 2. Where things stand today

### 2.1 MarkPDF — what already exists

| Capability | Where it lives | Process |
| --- | --- | --- |
| PDF render + text extraction | `src/pdf/document.ts` (PDF.js) | Renderer |
| Automatic conditional OCR | `src/pdf/ocr.ts` (Tesseract.js) | Renderer |
| Embedding index + vector search | `src/semanticIndex.ts` (Transformers.js + `sql.js`) | Renderer |
| Index file persistence only | `electron/semantic.ts` | Main |
| Markdown conversion, 3 engines | `src/documentConversion/` | Renderer (orchestration) |
| Docling process execution | `electron/documentConversion.ts` (`execFile`) | **Main (real Node.js)** |
| Provider registry, key encryption, CLI detection | `electron/ai.ts` | Main |
| Annotations, forms, signatures | `src/App.tsx` + `pdf-lib` | Renderer |

Three specific behaviours worth naming, because the plan builds on them:

- **OCR is already automatic and already conditional.** On open, `startAutoOcr` samples pages 1, 2, 3, middle, and last for text density. A normal digital PDF is marked `skipped` and never touches Tesseract. Only genuinely scanned files are processed. This is correct and should not change.
- **The Markdown engine router already exists.** `selectMarkdownEngine` profiles sampled pages for text density and image-paint operations, then routes to `builtin-text`, `docling-managed`, or `docling-vlm-smoldocling`. This is structurally the same heuristic the Pipeline project independently arrived at.
- **Search results are page-anchored.** `document_chunks` stores `page_number`; `searchSemanticDocument` returns `{ id, page, snippet, score }`. This property is the foundation of everything downstream and must be preserved at all costs.

### 2.2 The three findings

**Finding 1 — The AI layer is dead weight.**
Providers, encrypted keys, model lists, and detection of `codex` / `claude` / `gemini` / `qwen` are all built and wired into settings. Nothing consumes them except semantic search. This is the largest unrealised asset in the repository.

**Finding 2 — There are two parallel extraction paths that never meet.**
The Markdown conversion layer produces structured Markdown, but it is only reachable from the user-initiated **Save as Markdown** export action. The semantic index ignores it entirely and chunks raw `extractPageText` output plus OCR text instead. The same document is therefore extracted twice, by two different pipelines, and the *worse* of the two feeds search.

The consequence is measurable. Chunking currently splits page text on whitespace into fixed token windows. Headings, lists, and tables are flattened into undifferentiated word sequences before they are ever embedded. On the Pipeline project's 200-document benchmark, this class of approach scored **0.000 on table extraction**; a structural parser scored **0.814**. A table handed to an agent as flat text is not merely unhelpful — it is confidently wrong.

**Finding 3 — The core is renderer-bound.**
OCR, embeddings, the vector store, and PDF text extraction all run in the Chromium renderer. They depend on `canvas` rasterisation, WebAssembly (WASM) modules loaded from `import.meta.env.BASE_URL`, `crypto.subtle`, `window.setTimeout`, Vite `?url` asset imports, and `window.pdfReader.*` Inter-Process Communication (IPC) bridges.

The one exception is Markdown conversion, whose heavy lifting is already in the main process via `execFile`.

Two consequences follow. First, an MCP server — a bare Node.js process — cannot import any of it. Second, and independently important: **none of MarkPDF's core logic is unit-testable without a browser today.** The `yieldToBrowser()` calls scattered through indexing are a symptom of long-running work competing with the UI thread.

---

## 3. Target architecture

### 3.1 Package shape

```
markpdf/
  packages/
    core/          @markpdf/core   — pure Node.js. No Electron, no window, no DOM.
                                     parse → markdown → chunk → embed → store → search
    cli/           @markpdf/cli    — shell surface + SKILL.md. Ships first. May be wide.
    mcp/           @markpdf/mcp    — MCP server. Must stay narrow.
  app/                             — the Electron reader. A *client* of core.
```

The rule that keeps this honest: **`@markpdf/core` must have zero imports from `electron`, and must run under plain `node`.** If a change to core requires a browser to test, the change is wrong.

### 3.2 What runs where, after the refactor

| Concern | Before | After |
| --- | --- | --- |
| PDF text extraction | Renderer (PDF.js in browser) | Core (PDF.js + `@napi-rs/canvas`) |
| OCR | Renderer (Tesseract.js, WASM from URL base) | Core (Tesseract.js Node paths) |
| Embeddings | Renderer (Transformers.js in browser) | Core (Transformers.js on `onnxruntime-node`) |
| Vector store | Renderer (`sql.js` WASM, whole-file export over IPC) | Core (`better-sqlite3`, native) |
| Markdown conversion | Split renderer/main | Core (already mostly Node.js — least work) |
| Hashing | `crypto.subtle` | `node:crypto` |
| Reader UI | Owns everything | Calls core through main-process IPC |

### 3.3 The shared index — a decision that must be made early

Once both the Electron application and the MCP server can index documents, they contend for one SQLite database file.

The current design makes this actively dangerous: `sql.js` loads the entire database into renderer memory and writes it back **wholesale** via `saveDatabase`. Two processes doing that concurrently is a guaranteed lost-update.

**Decision:** the core owns the database using `better-sqlite3` with Write-Ahead Logging (WAL) enabled. `sql.js` is removed entirely. The Electron renderer never touches the database; it calls the main process, which calls core. The MCP server calls core directly. Schema version is stamped and checked on open.

Store location: a single well-known application data directory shared by both the app and the server, resolvable by an environment variable override for testing. Documents are keyed by content hash, exactly as they are today — so opening the same file in the reader and querying it from an agent hit the same rows.

---

## 4. The agent surface: CLI and MCP

### 4.0 Two surfaces, one core — and why both

There is a live argument that MCP is being displaced by plain command-line tools for agent integration. The argument has real merit and should be taken seriously rather than dismissed:

- **MCP tool definitions cost context permanently.** Every tool a server exposes sits in the client's tool list on every turn, used or not. A wide MCP surface is a standing tax.
- **CLI is progressive disclosure.** An agent reads `--help` only when it needs to. Cost is paid on demand, not continuously.
- **Agents are already excellent at shells.** Claude Code, Codex, Gemini CLI and Qwen CLI have a terminal and know how to use it. Notably, these are the *exact* agents `electron/ai.ts` already detects — MarkPDF detects them; they could drive MarkPDF.
- **CLI composes; MCP does not.** Pipes, `jq`, `xargs`, and shell scripts chain without a model round trip between every step. Each MCP call costs a full turn.
- **CLI is testable and scriptable by humans**, works under cron, and needs no protocol implementation.

But MCP does not go away, for three reasons that are specific to this project:

1. **The Pipeline project is an MCP consumer by architectural decision.** Its parent-process broker owns connections, grants, and revocation; workers never get to shell out arbitrarily. Phase 5 is not reachable without an MCP server. This is not a preference — it is a hard constraint of the other codebase.
2. **Graphical clients have no shell.** Desktop and hosted agents can reach an MCP server and cannot reach a binary.
3. **Schemas, resources, and prompts have no CLI equivalent.** Validated arguments mean fewer malformed calls, and `markpdf://doc/{hash}` resources let a client attach a document directly.

**Decision:** both surfaces ship, both are thin wrappers over `@markpdf/core`, and the CLI ships first. The marginal cost of the second surface is small precisely because Phase 0 put all the logic somewhere neither of them owns.

### 4.0.1 The governing principle

> **The CLI may be wide. The MCP surface must be narrow.**

CLI surface area is paid on demand, when an agent reads `--help`. MCP surface area is paid on every turn of every session, forever. So the CLI can expose every operation the core supports, including convenience flags and batch modes. The MCP server exposes the smallest set that covers the work — Tier 1 below is four tools, and that restraint is the correct response to the context-cost critique, not an accident.

### 4.0.2 CLI shape

Command-per-operation, mirroring the core: `outline`, `search`, `read`, `convert`, `tables`, `index`, `list`, `annotate`, `images-to-pdf`.

Requirements that make it agent-usable rather than merely human-usable:

- **`--json` on every command**, emitting the same structures the MCP tools return. Agents parse; humans read the default rendering.
- **Meaningful exit codes** — distinguish "not found", "not indexed", "outside allowlist", and "parse failed".
- **Batch and glob input** on `index` and `convert`, so a folder is one invocation rather than a loop of model turns.
- **Streaming progress to stderr**, results to stdout, so piping stays clean.
- **A `SKILL.md`** shipped alongside, teaching an agent the command vocabulary and the common workflows. This is the roadmap item, and it is what makes the CLI discoverable without `--help` spelunking.

### 4.1 MCP design principles

1. **Page-anchored or it doesn't ship.** Every result that refers to document content carries a page number. This is what makes agent output verifiable and what makes citations clickable.
2. **Cheap by default, expensive on request.** An agent should be able to orient itself for almost nothing, then pay only for what it actually needs.
3. **Bounded output, always.** Documents are large; agent context is not. Every tool has a byte budget, truncates explicitly rather than silently, and offers a file-path return for anything oversized.
4. **A small surface.** Every exposed tool costs context in every client's tool list, forever. Nine tools is already near the limit of what is polite.
5. **Deterministic and cached.** Content-hash keying means a repeated call is free.

### 4.2 MCP tools, in three tiers

The CLI exposes all of these and more. The tiers below govern the **MCP** surface only, where restraint matters.

Each tool is also marked with its access class from Section 4.6 — **[index]** for tools that read only the local database, **[fs]** for tools that touch the filesystem, and **[fs-write]** for tools that create or modify files. This is a security boundary, not a label: **[index]** tools need no filesystem permission at all.

#### Tier 1 — ship first (the minimum useful server)

**`markpdf_outline`** — orient without reading. **[index]** if already indexed, **[fs]** otherwise.
*In:* `path`
*Out:* title, page count, heading tree with page numbers, table locations, whether the document is native-text or scanned, index status, content hash.
*Why it exists:* agents that can see a document's shape before searching perform dramatically better than agents that search blind. This is the cheapest call and should be the one agents reach for first.

**`markpdf_search`** — semantic retrieval. **[index]**
*In:* `path` *or* `document_id`, `query`, `top_k`, `min_score`, `scope` (`document` | `library`)
*Out:* array of `{ page, heading_path, snippet, score, chunk_id }`
*Why it exists:* the core value. `heading_path` is new — it is what structure-aware chunking (Phase 1) buys us, and it lets an agent understand *where* in the document a hit sits, not just which page.

**`markpdf_read_pages`** — go from a hit to real context. **[index]** for an indexed document.
*In:* `path`, `pages` (e.g. `"3"`, `"3-7"`, `"3,9,14"`), `include_annotations`
*Out:* page-scoped Markdown.
*Why it exists:* search returns snippets; reasoning needs the surrounding material. This is the bridge.

**`markpdf_to_markdown`** — the deterministic conversion tool. **[fs]**, or **[fs-write]** when `output_path` is given.
*In:* `path`, `pages?`, `mode` (`page-preserving` | `clean`), `engine` (`auto` | `fast` | `accurate` | `vlm`), `output_path?`
*Out:* Markdown inline **below** a byte threshold; above it, writes a file and returns the path plus a structural summary.
*Why it exists:* roadmap item — a fixed, reliable PDF-to-Markdown tool. Also the single most requested thing agents want from a PDF.

#### Tier 2 — shortly after

**`markpdf_extract_tables`** — **[index]** for an indexed document, **[fs]** otherwise.
*In:* `path`, `pages?`, `format` (`markdown` | `csv`)
*Out:* tables with page references.
*Why separate from `to_markdown`:* it is a distinct, high-precision, high-value ask, and agents phrase it that way. Bundling it into full conversion makes agents pull a whole document to get one table.

**`markpdf_index`** — **[fs]**. This is the consent event (Section 4.6).
*In:* `path` (file or directory), `recursive`, `force`
*Out:* document identifiers and per-file status.
*Why it exists:* lets an agent prepare a corpus before working over it, rather than paying indexing cost inside a query.

**`markpdf_list_documents`** — **[index]**
*In:* `filter?`, `limit`
*Out:* indexed documents with hash, page count, source path, indexed-at.
*Why it exists:* `scope: "library"` search is meaningless if the agent cannot discover what the library contains.

#### Tier 3 — later, and only if wanted

**`markpdf_annotate`** — write-side. **[fs-write]**
*In:* `path`, `page`, `text_anchor` or quad coordinates, `type` (`highlight` | `comment`), `body`, `author`
*Out:* annotation identifier.
*Why it matters:* this is the tool that closes the human loop. An agent marks up a document; you open it in MarkPDF and see the marks. Because MarkPDF writes standard PDF annotations, they are also visible in Acrobat-compatible readers. This is also the mechanism behind the Pipeline feedback loop in Phase 5.

**`markpdf_images_to_pdf`** — **[fs-write]**
*In:* `image_paths[]`, `output_path`, `page_size`
*Out:* output path.
*Why it exists:* existing roadmap item; deterministic; trivially useful; costs almost nothing to expose once the server exists.

### 4.3 Resources and prompts

MCP exposes more than tools. Two cheap additions worth making once the tools work:

- **Resources** — publish indexed documents under stable `markpdf://doc/{hash}` Uniform Resource Identifiers (URIs) so MCP clients can attach a document directly rather than passing paths around.
- **Prompts** — ship one or two, e.g. *"summarise this document with page citations"*, so a client gets a good default interaction without the user composing it.

Neither is required for Phase 2. Both are small.

### 4.4 Transport

- **stdio — primary.** This is what Claude Code, Codex, and most desktop MCP clients speak. It is also what makes the server usable *anywhere*, which is the stated goal.
- **Streamable HTTP — secondary.** Needed for the Pipeline project, whose broker supports stdio and Streamable HTTP as first-class transports and explicitly does not support legacy Server-Sent Events (SSE).

### 4.5 Safety — non-negotiable

The server reads arbitrary files by path. Without constraint, any agent that can reach it can read any PDF on the disk.

- **Path allowlisting is mandatory.** The server operates only within configured root directories. Default to none configured; require explicit opt-in.
- **Reject path traversal** and resolve symbolic links before the allowlist check.
- **Write-side tools** (`annotate`, `to_markdown` with `output_path`, `images_to_pdf`) need a separate, stricter allowlist than read-side tools.
- **Treat document content as untrusted input.** A PDF can contain text that reads as instructions. Content returned by these tools is data, never direction.
- **Bound every output.** Byte caps, explicit truncation markers, and no unbounded directory walks.

This matters more than usual because the Pipeline project's broker treats stdio servers as local code execution requiring a trust digest over the exact command and arguments. A loose server is a liability in that model.

### 4.6 Access and consent model

There is no hidden authorisation system here, and conflating its layers is what makes it feel mysterious. There are three, and they are owned by different parties.

**Layer 1 — how a client is permitted to reach MarkPDF at all. Owned by the user.**

- *MCP:* the user registers the server once in their client's configuration (for example `claude mcp add markpdf …`). For stdio transport the client then spawns the MarkPDF binary as a subprocess. Nothing connects that the user did not put in that file. **The config file is the authorisation.**
- *CLI:* simpler still. An agent with a shell already has the mechanism; the agent's own permission system asks before running commands, or the user allowlists `markpdf`. No registration exists to bypass.

Nothing needs to be built for this layer. It is worth stating only because it is the layer people assume is complicated.

**Layer 2 — what MarkPDF permits once running. Owned by MarkPDF.**

The client will happily ask for `~/.ssh/id_rsa`. Refusing is MarkPDF's job, not the client's. This is the allowlisted roots of Section 4.5, with symlinks resolved *before* the check and a stricter root set for writes.

**Layer 3 — the index is not the filesystem. This is the organising idea.**

> **Indexing is the consent event.**

Querying the index is categorically different from reading files. A document reaches the index only because someone deliberately put it there, so the index is a record of what the user has already agreed to expose.

This gives three access classes, used to mark every tool in Section 4.2:

| Class | Reads | Examples | Filesystem permission required |
| --- | --- | --- | --- |
| **[index]** | Local database rows only | `search`, `list_documents`, `read_pages` on an indexed document | **None** |
| **[fs]** | Files under the allowlisted roots | `index`, `outline` and `convert` on a new path | Read allowlist |
| **[fs-write]** | Creates or modifies files | `annotate`, `images_to_pdf`, `to_markdown --output` | Write allowlist |

Most of the surface — including the highest-traffic tool, `search` — falls in **[index]** and therefore needs no filesystem permission whatsoever.

Two properties follow, and both are worth having:

1. **The risk becomes legible to the user.** "Whatever I indexed is what agents can see" is a sentence a person can actually reason about. "Trust the allowlist" is not.
2. **The blast radius of a misconfigured client is bounded** by a deliberate prior action rather than by the correctness of a path check.

Deleting a document from the index is therefore a withdrawal of consent and must actually remove its chunks, not merely hide it.

**Layer 4 — content is data, never instruction.** Restating Section 4.5 because it belongs to this model: a document can contain text that reads as a command. Anything these tools return is content to be reasoned about, never direction to be followed.

---

## 5. Roadmap

The ordering below reflects the decision to lead with MCP. The governing property is that **each phase is independently valuable** — if work stops after any phase, what exists is still better than what came before. This is not a big-bang refactor.

### Phase 0 — Extract the core

**Goal:** `@markpdf/core` exists, runs under plain `node`, and is unit-testable without a browser.

**Scope:** move PDF text extraction, OCR, chunking, embedding, and the vector store out of the renderer. Swap `canvas` for `@napi-rs/canvas`, `sql.js` for `better-sqlite3`, `crypto.subtle` for `node:crypto`. Point Tesseract.js at `node_modules` worker and core paths rather than a Uniform Resource Locator (URL) base. Transformers.js already runs on `onnxruntime-node`, so embeddings port with little change. Markdown conversion is largely main-process already and moves most easily.

**Done when:** the full parse → index → search cycle runs from a Node.js test with no Electron and no browser.

**Why it is worth doing alone:** it is the first time this logic can be tested at all.

### Phase 1 — Markdown as the internal representation

**Goal:** the index is built from structured Markdown, not raw page text.

**Scope:**
- Convert on open using the **fast** engine, in **page-preserving** mode.
- Cache the result by content hash in the application data directory — *not* beside the source file (see Decision D3).
- Replace whitespace-window chunking with structure-aware chunking: split at headings, keep tables intact, and prepend the heading breadcrumb to each chunk's embedded text.
- Persist `heading_path` alongside `page_number` on each chunk.
- Evaluate replacing the `builtin-text` engine with `@firecrawl/pdf-inspector` — Massachusetts Institute of Technology (MIT) licensed, native Node.js package, benchmarked by the Pipeline project at 0.875 overall against 0.615 for the previous approach, including 0.814 against 0.000 on tables.

**Done when:** searching a table-heavy PDF returns intact table rows with correct page numbers and heading context.

**Why it is worth doing alone:** this is the single largest available improvement to search quality — larger than changing embedding models — and it lands entirely inside MarkPDF with no external dependency.

### Phase 2a — The CLI and its skill

**Goal:** `@markpdf/cli` plus a `SKILL.md`; MarkPDF drivable from any shell, by a human or by Claude Code, Codex, Gemini CLI, or Qwen CLI — with the reader closed.

**Scope:** command-per-operation over core, `--json` everywhere, meaningful exit codes, batch and glob input, progress on stderr. Path allowlisting (Section 4.5 applies identically here — the constraint belongs to core, not to a transport). Packaging and installation instructions.

**Done when — the acceptance test is literal, and should be run exactly as written:**

```bash
markpdf index ~/Papers/some-paper.pdf
claude
> using markpdf, find what this paper says about <X>
```

Success is Claude returning the passage **with its page number**, having shelled out to `markpdf search --json` on its own initiative from the `SKILL.md`. Nothing about this test involves the Pipeline project, and it must pass with the reader application closed.

Secondary check: `markpdf index ~/Papers --recursive` then `markpdf search "…" --scope library --json | jq` behaves for a human at a shell.

**Why it comes before the MCP server:** it is strictly less work — no protocol, no transport, no connection lifecycle. It is also the better debugging surface: you can exercise the core from a shell before wrapping it in anything. And it carries zero standing context cost for the agents you already detect.

### Phase 2b — The MCP server

**Goal:** Tier 1 tools over stdio; MarkPDF reachable from graphical and hosted MCP clients, and from the Pipeline project's broker.

**Scope:** `@markpdf/mcp` wrapping the same core operations the CLI already proved. Output budgets. Optionally resources and prompts (Section 4.3). Streamable HTTP transport added when Phase 5 needs it.

**Done when — the same test, through the other surface:**

```bash
claude mcp add markpdf -- markpdf mcp
claude
> using markpdf, find what this paper says about <X>
```

Success is identical: the passage, with its page number, this time via `markpdf_search` rather than the shell. Running the *same* task through both surfaces is deliberate — it proves the two are wrappers over one core rather than two divergent implementations.

Negative check, equally required: a request for a path outside the allowlist is refused, and an **[index]** tool succeeds with no filesystem permission granted at all.

**Why it is still required, given the CLI exists:** graphical and hosted clients have no terminal. And the Pipeline project cannot shell out — its broker owns connections and grants by architectural decision — so Phase 5 is unreachable without it.

### Phase 3 — The reader consumes the core

**Goal:** one implementation, not two.

**Scope:** the Electron application drops its renderer-side OCR, indexing, and store code and calls core through main-process IPC. Renderer keeps rendering, annotation, and UI state — which is what it should have been doing.

Temporary duplication between Phase 0 and Phase 3 is acceptable but should be time-boxed. Running two implementations of the same index over one database is precisely the hazard Decision D4 exists to prevent.

**Done when:** `sql.js`, renderer-side Tesseract, and renderer-side Transformers.js are gone from the application bundle.

**Why it is worth doing alone:** removes the duplication, shrinks the bundle, and moves long-running work off the UI thread — the `yieldToBrowser()` workarounds can go.

### Phase 4 — Quick ask

**Goal:** the dormant provider layer finally does something.

**Scope:** select text or a region, ask a question, get an answer grounded by `markpdf_search` and cited to a page, rendered in a popover. One model, one turn. Uses the existing provider registry and detected CLI agents.

**Done when:** a question over a selection returns a cited answer in seconds, using a locally configured provider.

**Why it is worth doing alone:** it converts the largest piece of unused code in the repository into the app's headline feature, and it is genuinely differentiated — a grounded lookup, not a chat window.

### Phase 5 — Convene a board

**This phase spans two repositories and must be tracked as two separate pieces of work.** Do not begin either until Phases 1 and 2b are done, because both depend entirely on retrieval quality and a stable MCP surface.

The important structural point: **if Phases 2a and 2b were built correctly, the MarkPDF side of this is nearly nothing.** Pipeline registers MarkPDF as an MCP server exactly the way Claude Code does. There is no bespoke connection to build.

**5a — MarkPDF side (this repository). Small.**

- A launch affordance: select a passage, choose a team, send.
- A pane that renders the returned Markdown report with clickable page citations — MarkPDF is already a Markdown reader, so this is display, not new capability.
- Export of highlights and comments as structured feedback.

That is the entire MarkPDF-side scope. None of it is Pipeline-specific (see D10) — the launch affordance posts to a configured endpoint, and the pane renders Markdown from anywhere.

**5b — Pipeline side (other repository, separate plan).**

- Register MarkPDF as an MCP connection; grant the relevant agents access to its tools.
- Accept an inbound run request carrying document context.
- Consume exported annotations as input to a `review` stage or a `manual` gate — the highlighter becomes a gate verdict.

Teams already exist and need no new work: `problem-thinking-board`, `venture-capital-team`, `software-architecture-board`, among others.

**The shape, once both sides exist** — note that it is a loop, not a line. MarkPDF starts the run; Pipeline's agents call *back* into MarkPDF's MCP server for retrieval while deliberating; the report returns with page citations that resolve in the reader.

**Done when:** selecting a passage, choosing a board, and receiving a cited report works end to end.

**Why it is last:** it is the only phase depending on a second application, and it is worthless unless Phases 1 and 2 are already good.

### Phase 6 — Optional consolidation

Extract the shared provider layer — provider records, encrypted key storage, model discovery, CLI detection — currently implemented independently in both MarkPDF and Pipeline. Unglamorous, but it is what stops two of everything being maintained forever.

---

## 6. The two-tier interaction model

A decision that shapes Phases 4 and 5, and is easy to get wrong.

A Pipeline team run is not a chat. It is minutes of wall-clock, many model calls, gates, and budget constraints, producing a report artifact. Convening a board to ask *"what is the date on page 3"* is absurd.

| | Quick ask | Convene a board |
| --- | --- | --- |
| Engine | One model, one turn | Pipeline team, multi-stage |
| Latency | Seconds | Minutes |
| Output | Cited answer in a popover | Report artifact in the side pane |
| Retrieval | `markpdf_search` | `markpdf_search`, called repeatedly by agents |
| Invocation | Keyboard shortcut on selection | Explicit, deliberate, named team |

Same retrieval underneath; entirely different interactions. Keeping them visibly distinct is what preserves MarkPDF's stated position of *not* being a chat-with-PDF application: the fast tier is a lookup, and the slow tier is something no chat application does at all.

---

## 7. Design decisions

**D1 — Markdown is the internal representation, not an export format.**
The index reads from converted Markdown rather than raw page text. Rationale: structure-aware chunks are the largest available lever on retrieval quality, and structured content is what makes agent grounding trustworthy.

**D2 — Page-preserving conversion is mandatory for indexing.**
Full-document Markdown loses page identity. The Pipeline project had to add a separate page-locator artifact precisely because of this. MarkPDF already has `page-preserving` mode and `renderPageAnchor`; indexing must use them. Losing page anchoring would forfeit clickable citations, which is the property that makes the whole agent story worth building.

**D3 — Derived artifacts are cached in application data, never beside the source.**
Writing a stray `.md` next to every opened PDF litters the user's folders and invents a drift question — which copy is authoritative after an edit? Cache by content hash next to the index. Export to a real file only when explicitly requested; that action already exists.

**D4 — One writer, one database engine.**
`better-sqlite3` with WAL in core; `sql.js` removed. Two processes performing whole-database read-modify-write is a guaranteed lost-update.

**D5 — stdio is the primary transport.**
It is what makes the server usable anywhere, which is the point. Streamable HTTP is added for Pipeline, which supports it first-class.

**D6 — Automatic means the fast engine only.**
Docling requires a Python virtual environment and a pip install. It must never sit on the open-a-file path. Heavy and Vision Language Model (VLM) engines stay on-demand or background-upgrade.

**D7 — OCR stays conditional.**
The existing sample-and-skip behaviour is correct. A native text layer is better and far faster than OCR; OCR is a fallback, not a default.

**D8 — Two surfaces, CLI first; the CLI may be wide, MCP must be narrow.**
CLI surface is paid on demand via `--help`; MCP surface is paid on every turn of every session. The CLI ships first because it is less work, is the better debugging surface for core, and serves the CLI agents MarkPDF already detects. MCP still ships because the Pipeline project is an MCP consumer by architectural decision and cannot shell out, and because graphical clients have no terminal. Both are thin wrappers over one core — which is exactly what Phase 0 buys.

**D9 — Safety constraints live in core, not in a transport.**
Path allowlisting, symlink resolution, output budgets, and untrusted-content handling are enforced by `@markpdf/core`. Neither the CLI nor the MCP server may be the place a check lives, or the two surfaces will drift and one will become the soft target.

---

**D10 — Client neutrality: MarkPDF contains no Pipeline-specific code, ever.**
Pipeline is one consumer among many, and **Claude Code is the reference client** — if a capability cannot be exercised from a plain terminal, it is not finished. Where Pipeline needs something MarkPDF does not already offer generically, Pipeline adapts. This is what keeps "consumable by any AI tool" true rather than aspirational, and it is why Phase 5 splits across two repositories instead of introducing a bespoke coupling.

**D11 — Indexing is the consent event.**
Access control is organised around the index rather than around path checks alone (Section 4.6). Tools are classified **[index]**, **[fs]**, or **[fs-write]**, and the majority — including `search` — require no filesystem permission at all. Removing a document from the index must genuinely delete its chunks, because that action is a withdrawal of consent.

---

## 8. Risks and guardrails

**Minimalism erosion.** MarkPDF's stated identity is minimal by design. Every phase adds surface area.
*Guardrail:* one panel and one settings page in the UI. Everything else lives behind the MCP and CLI boundary, where capability costs no interface.

**Phase 0 sprawl.** Core extraction is the phase most likely to expand without limit.
*Guardrail:* the exit criterion is a passing Node.js test of parse → index → search. Not perfection, not full parity — one green test.

**Two applications, two release cadences.** A shared core package is a coupling that will be felt on every release.
*Guardrail:* version the core independently and pin it; do not develop against a floating local link.

**Designing for an audience of one.** There is currently one consumer of this MCP contract.
*Guardrail:* ship Tier 1 and stop. Do not design Tiers 2 and 3 in detail until a second consumer exists and has complained.

**Prompt injection through document content.** Documents are attacker-controlled in the general case.
*Guardrail:* content returned by MCP tools is data. Never let it steer tool selection or arguments.

---

## 9. What success looks like

- MarkPDF's provider layer is load-bearing rather than dormant.
- Search quality improves enough that the roadmap's *"good but not great"* note can be deleted.
- Core logic has tests that run in continuous integration without a display server.
- MarkPDF is reachable from any MCP client, closed or open.
- Roadmap items 3 (MCP/CLI exposure), 4 (multi-agent discussion), and 6 (better semantic search) are delivered by one coherent programme rather than three unrelated efforts. Items 1 (plugin interface) and 5 (Obsidian bridge) become substantially cheaper afterwards.

---

## 10. Open questions

1. Should `scope: "library"` search across the whole index ship in Tier 1, or wait until `list_documents` exists in Tier 2? Cross-document search is a different retrieval problem and may deserve its own design pass.
2. Does the index need per-document eviction, or is content-hash dedup plus manual clear sufficient at personal scale?
3. ~~Should the CLI wrap the same operations as MCP?~~ **Resolved (D8):** the CLI is wide, the MCP surface is narrow. Both wrap the same core. Remaining sub-question: should the `SKILL.md` be distributed inside the CLI package, or separately so it can be updated without a release?
4. Is `@firecrawl/pdf-inspector` worth its native-binary packaging cost across platforms, given Docling already covers the accurate tier? Requires a packaging spike before committing.
5. How should the reader present an agent-authored annotation differently from a human one?

---

## 11. Evidence map

Every non-obvious claim above, and where to verify it.

| Claim | Source |
| --- | --- |
| OCR is automatic and conditional on open | `src/App.tsx` → `startAutoOcr`; `src/pdf/ocr.ts` → `detectOcrNeed` samples pages 1, 2, 3, middle, last |
| Indexing is automatic when enabled | `src/App.tsx` → `startSemanticIndex` |
| Chunks carry page numbers | `src/semanticIndex.ts` → `document_chunks.page_number` |
| Search returns page-anchored hits | `src/semanticIndex.ts` → `searchSemanticDocument` returns `{ id, page, snippet, score }`, top 12 |
| Chunking is whitespace windows | `src/semanticIndex.ts` → `chunkPageText`, `page.text.split(/\s+/)` |
| Index does not use Markdown conversion | `src/semanticIndex.ts` → `extractDocumentText` reads `extractPageText` plus OCR text |
| Markdown conversion is export-only | `src/App.tsx` lines ~1613 and ~1719 — reached solely from the save dialog |
| Three Markdown engines with an auto router | `src/documentConversion/engineSelection.ts` → `builtin-text`, `docling-managed`, `docling-vlm-smoldocling` |
| Core is renderer-bound | `src/semanticIndex.ts` uses `sql.js` WASM, `crypto.subtle`, `window.pdfReader`; `src/pdf/ocr.ts` uses `import.meta.env.BASE_URL` and canvas |
| Only the DB *file* crosses IPC | `electron/semantic.ts` exposes load/save/clear/info only |
| Markdown conversion is already Node-side | `electron/documentConversion.ts` uses `execFile` for Docling |
| Provider layer is built and unused | `electron/ai.ts`; `electron/preload.ts` `ai.*` bridge; consumed only by settings |
| Pipeline is MCP-consumer-only with a parent broker | Pipeline `docs/2026-07-12-MCP-Client-Control-Plane.md` |
| Pipeline supports stdio and Streamable HTTP, not legacy SSE | same |
| Parser benchmark figures | Pipeline `docs/2026-08-09-PDF-Inspector-Integration.md` |
| Vision escalation is a known recurring cost | Pipeline `docs/2026-07-11-Direct-PDF-Document-Reader.md` |
| Pipeline binds `127.0.0.1` on a random port with a per-launch token | Pipeline `README.md` |

---

## 12. Glossary

- **ADR** — Architecture Decision Record
- **AI** — Artificial Intelligence
- **API** — Application Programming Interface
- **CLI** — Command Line Interface
- **HTTP** — Hypertext Transfer Protocol
- **IPC** — Inter-Process Communication
- **MCP** — Model Context Protocol
- **MD** — Markdown
- **MIT** — Massachusetts Institute of Technology (software licence)
- **OCR** — Optical Character Recognition
- **PDF** — Portable Document Format
- **SSE** — Server-Sent Events
- **UI** — User Interface
- **URI / URL** — Uniform Resource Identifier / Locator
- **VLM** — Vision Language Model
- **WAL** — Write-Ahead Logging
- **WASM** — WebAssembly
