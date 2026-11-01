# 2026-11-01 Folder access in Settings

## Status

Accepted for implementation by the user's 2026-11-01 request and decisions D1–D6.
Amends the consent-channel decision in [MCP server adapter](2026-08-23-MCP-Server-Adapter.md); its other decisions remain in force.

## Context

People need to see and change agent folder grants in General settings. The consent
model in `core/consent/allowlist.ts` separates read and write roots. The MCP adapter
previously described the command line as the only out-of-band consent channel.
The [reviewed plan](../folder-access-settings-plan.md) records the trust analysis
(F25–F27) and the user decisions in the [requirements](../folder-access-settings-prd.md).

## Options considered

| Option | For | Against |
| --- | --- | --- |
| Keep command-line-only consent | Retains the existing channel | People cannot inspect or repair grants in Settings |
| Desktop consent with native confirmation on every widening | Adds a gesture at a native dialog | Adds friction without reducing application-page authority |
| Desktop consent trusting the application main frame | Makes grants visible and editable | Relies on document content remaining outside page-script authority |

## Decision

Consent is given out of band by a person, through the command line or desktop
Settings. No MCP tool, agent command or desktop agent request may change grants.
The agent import guard and `electron/folderAccess.ts` sender check enforce this
boundary. The handlers accept only the application's main frame in a live MarkPDF
window; they do not prove that a person clicked.

Adding uses a native picker; removal always uses native confirmation. Narrowing
asks when other stored roots lose access. Widening R to RW and narrowing without
other affected roots do not require native confirmation. Application page script
already has unrestricted file read/write IPC, including access to the consent
record (`electron/main.ts`, F26). A script able to widen a grant can already write
the file directly. The Codex plan review accepted that an extra widening dialog
would not reduce this power under the current boundary.

## Consequences

- React rendering of Markdown, Mermaid strict mode and its sanitization, filtered
  PDF links, and the new-window handler currently keep document content outside
  page-script authority. A same-window navigation guard and a Content Security
  Policy do not exist (F25). These controls must not be claimed as present.
- The consent lock protects the record, not directory identity. Each transaction
  resolves or inspects each path once and writes exactly its planned record.
  Widening a missing, moved or unreadable root is refused; withdrawal uses stored names.
- Removing grants does not delete indexed content. Agents may still search and
  read the index, and a granted ancestor may retain direct file access.
- A navigation guard, a Content Security Policy and file-IPC path checks remain
  separate follow-up hardening, outside this feature.

## Revisit when

Any feature renders raw document HTML, changes script execution or navigation,
restricts the existing file IPC, or allows agents to reach grant-changing code.
