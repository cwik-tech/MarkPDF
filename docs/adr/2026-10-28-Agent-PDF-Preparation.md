# 2026-10-28 Agent PDF preparation through the desktop

## Status

Accepted on 2026-10-28 under the user's instruction to implement the reviewed preparation plan. Supersedes the MCP no-indexing restriction and extends passive open-document awareness for this explicit operation.

## Context

Agents can already retrieve indexed PDFs, but could not ask MarkPDF to open a new path, persist generated outline metadata and acknowledge readiness. The user requested this workflow with existing storage, separate save/index outcomes and disclosed fallback when extraction is incomplete. Existing MCP and open-document decisions prohibit indexing and prefer private session files over a socket.

## Options considered

| Option | For | Against |
| --- | --- | --- |
| Keep CLI indexing and OS-open only | Smallest existing interface | Cannot acknowledge saving or coordinate the desktop lifecycle |
| Add a socket service | Bidirectional live control | New listener, framing, discovery and service lifecycle |
| Extend single-instance requests with private results | Reuses desktop launch and session ownership; no listener | Requires correlation, event-driven waiting, cancellation and stale-result handling |

## Decision

Add one explicit MCP preparation tool and a matching CLI command. Route both to the desktop through its existing single-instance launch mechanism with private, correlated request/result records, preserving existing grants and the shared core index.

## Consequences

- MCP preparation may index and save within existing grants; it cannot grant, delete or forget documents. Existing cached retrieval access classes remain intact.
- Automatic saving uses a narrow outline exporter and refuses unsupported source/file cases. Saving still rewrites PDF bytes; OCR-derived content remains in the existing cache.
- Save ownership, source identity, cancellation and effective index scope must cross the desktop bridge explicitly. Failure after a completed save must preserve that fact.
- The skill guides configured agents to use preparation first, retrieve bounded evidence and disclose fallback. Client setup remains explicit.
- Protocol details and recovery belong in [the usage reference](../agent-pdf-preparation.md); implementation scenarios and verification status belong in [the plan](../agent-pdf-preparation-plan.md).

## Revisit when

Another operating system needs automatic replacement, an event-driven result channel cannot meet a concrete requirement, or the user requests per-file consent or automatic agent configuration.
