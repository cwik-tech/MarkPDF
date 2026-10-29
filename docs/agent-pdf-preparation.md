# Reading PDFs through an agent

Install the `markpdf` command from Settings → CLI & MCP, then register its MCP server with your agent. The reusable skill is `skills/markpdf-retrieval/SKILL.md`; install that folder through your client's supported skill mechanism. Each client needs its own registration and skill installation. Installing the desktop application alone does not configure every agent.

## Prepare and retrieve

```sh
markpdf --allow-read ~/Papers
markpdf --allow-write ~/Papers
markpdf prepare ~/Papers/report.pdf --json
```

The write grant permits overwriting files in that folder. Grant only locations you intend to use. It is unnecessary when no generated outline needs saving. MCP has no grant operation.

The MCP equivalent is `prepare_document` with an absolute `path`. Both routes open the PDF in MarkPDF and return a correlated completion receipt. The PDF stays at its existing path. Extracted page Markdown, provenance and vectors use the existing semantic SQLite store under the selected application data directory.

Use the returned `contentHash` with `search` and `read_pages`, or the open-document `ref` with `search`. Read a few relevant pages for focused questions. Use `outline` for structure; whole-document tasks should explicitly traverse bounded ranges or use `to_markdown` to export a file.

## Client registration

Registration commands verified against the installed clients' help:

```sh
claude mcp add --scope user markpdf -- markpdf mcp
codex mcp add markpdf -- markpdf mcp
```

Clients accepting an MCP server map can register `markpdf` as the command with `["mcp"]` as arguments. Use the client's documented user-level skill installation for the checked-in skill. Merge with existing settings rather than replacing them. The application does not automatically edit agent configuration.

Use `MARKPDF_DATA_DIR` in the server environment, or CLI `--data-dir`, to select a different store. The launched desktop uses that same directory. The command must run through the bundled Electron runtime, as the installed shim does.

## Interpreting results

`status` distinguishes ready, incomplete, needs_user_action, failed and cancelled. `save` separately distinguishes saved, not_needed, blocked, failed and unknown. A completed save remains completed if indexing subsequently fails. An unknown save outcome needs inspection rather than an automatic retry.

Successful receipts include the final hash, index outcome, model/profile, text source and bounded missing-page details. Check `coverageTruncated`. `list_open_documents` and `search` expose coverage separately from mere row existence; legacy provenance can remain unknown.

Generated outlines are what can make an otherwise unedited PDF dirty. Automatic outline saving does not embed OCR text into the PDF. It refuses encrypted, signature-bearing or form-bearing files, user-edit conflicts and unsupported file layouts. It never saves unrelated user edits. Automatic replacement currently requires macOS.

## Recovery and limits

Resolve missing grants, disabled semantic indexing and document conflicts before retrying. Incomplete extraction can remain searchable; use another permitted parser for missing pages and disclose the fallback. Repeating preparation for an incomplete index can repeat OCR.

The desktop admits one preparation at a time; another request receives a busy result. Agent-created windows do not automatically install the optional Docling exporter.

Fine-grained external preparation progress is not forwarded through the result channel; the desktop displays progress and the agent receives a completion receipt.

Preparation has a finite deadline. On timeout, cancellation is requested and the receipt reports the save outcome as unknown. Request/cancellation records are retained in the private `session/preparations` directory when completion cannot be acknowledged; inspect the PDF and index before retrying. Records are diagnostic material, not proof of success.

A socket server, automatic agent installer, new per-file consent UI and cloud OCR are outside this change. Preservation of every cloud-sync provider's behavior has not been established. The implementation's verification status is in [the plan](agent-pdf-preparation-plan.md#status-and-evidence-boundary).

Implementation: `core/agent/desktopClient.ts`, `electron/agentPreparation.ts`, `electron/preparationSave.ts`, `src/pdf/prepareOutline.ts`, and the preparation bridge in `src/App.tsx`. Verification scenarios: `tests/e2e/agent-pdf-preparation.spec.ts` and the co-located preparation tests.
