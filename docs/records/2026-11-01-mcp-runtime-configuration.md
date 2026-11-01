# MCP desktop request runtime, 2026-11-01

Source: the user reported that a comment reached the open PDF through the command line while
the MCP suggestion timed out.

Codex's user configuration launched the checkout's compiled MCP entry point with plain Node.js.
The server wires desktop requests to the shared channel in `mcp/context.ts`. That channel starts
`process.execPath` with the desktop request argument (`core/agent/desktopChannel.ts:129`). Under
this configuration it starts Node.js again, rather than Electron, and no desktop acknowledges.
Listing open documents does not exercise this handoff.

The installed shim selects the bundled Electron runtime (`core/install/cliShim.ts:63` and
`core/install/cliShim.ts:76`). The correction changes only Codex's MarkPDF command and arguments
to the installed command followed by `mcp`; all other client settings remain unchanged. A private
backup of the original configuration is retained outside the repository. No application code,
folder grants, hidden-window settings, or existing server processes were changed.

The earlier attribution to old backup application processes was incomplete. Those processes
were present, but this Codex session's server used plain Node.js. The reproduction compares the
original and corrected launch commands through the official MCP SDK, an isolated temporary
profile, a temporary PDF, and the existing hidden E2E renderer. It checks that one suggestion
appears and that the PDF bytes remain unchanged. This is configuration verification, not a
production-code TDD loop. The existing session must reconnect to load the corrected command.

The troubleshooting guidance now checks the MCP launch configuration before advising a desktop
restart. No ADR is needed for applying the existing documented installation route.
