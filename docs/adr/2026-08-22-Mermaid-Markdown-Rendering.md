# Mermaid Markdown rendering

## Status

Accepted

## Context

MarkPDF's Markdown parser recognizes fenced code blocks but previously rendered every language as source code. Documents containing `mermaid` fences therefore showed diagram definitions instead of charts. Implementing Mermaid's diagram grammar and layout algorithms inside MarkPDF would be a large, incomplete duplicate of an established renderer.

## Decision

Use Mermaid 11.17.0 to render `mermaid` fenced blocks in the Markdown preview. MarkPDF pins the direct dependency and loads it only when a Mermaid block needs rendering. It disables automatic page-load rendering, uses Mermaid's strict security level, and validates that rendered output has one SVG root before inserting it into the document. The renderer follows MarkPDF's active light or dark theme. Invalid Mermaid source produces an inline error and retains the source for diagnosis.

## Consequences

- Markdown documents can display Mermaid's supported diagram types without a network service.
- The renderer adds Mermaid and its transitive packages to the application bundle and dependency review scope.
- Mermaid rendering is asynchronous, so a chart has a short busy state while its SVG is generated.
- Future Mermaid upgrades require the Electron acceptance test to pass with representative HTML labels and custom styling.

## Alternatives considered

- Build a limited flowchart renderer in MarkPDF. This would not support the wider Mermaid grammar and would create an ongoing compatibility burden.
- Send diagram source to a hosted rendering service. This would require network access and disclose document content outside the application.
- Continue showing Mermaid source as a normal code block. This does not meet the expected Markdown preview behavior.
