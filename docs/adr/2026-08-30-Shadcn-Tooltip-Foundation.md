# Shadcn owns reusable renderer primitives

## Status

Accepted.

## Context

The CLI & MCP settings page needed compact information controls whose content opens on hover and
keyboard focus, remains accessible to assistive technology, and escapes the settings panel's
scrolling boundary. MarkPDF previously had no reusable tooltip primitive and no floating-layer
library. A local CSS tooltip could reproduce the shape, but it would also have to reproduce focus
handling, delayed open and close behavior, portal placement, collision handling, and accessible
relationships.

The requested component is shadcn's Tooltip. Shadcn distributes component source rather than a
runtime component package. Its Vite setup uses Tailwind to compile the generated component classes,
and the Tooltip delegates interaction and placement to Radix UI.

## Decision

Initialize the existing Vite renderer with shadcn's Radix-based configuration and add the official
Button and Tooltip sources under `src/components/ui/`. `src/main.tsx` provides `TooltipProvider`
once for the renderer. Settings composes `Tooltip`, `TooltipTrigger`, and `TooltipContent` around a
shadcn icon Button instead of owning tooltip state or tooltip-specific CSS.

Tailwind is limited to generated shadcn primitives and the utility classes used to compose them.
The existing stylesheet remains authoritative for the application shell and feature UI. Shadcn
theme variables use an `--ui-` prefix before Tailwind maps them to its color utilities, so existing
MarkPDF variables such as `--border`, `--muted`, and `--accent` keep their meanings.

Tooltip content uses a local `z-[200]` utility when rendered from Settings. Radix portals content at
the document root, where shadcn's default `z-50` sits behind MarkPDF's `z-index: 120` modal backdrop.
The higher value places the portalled content above the modal without changing the shared Tooltip
component.

## Consequences

- Renderer builds now include Tailwind's Vite plugin and the checked-in shadcn configuration.
- Reusable shadcn components belong under `src/components/ui/`; feature-specific layout remains in
  `src/styles.css`.
- Tooltip interaction, positioning, portal behavior, and accessibility come from Radix UI.
- The Electron package gains the bundled renderer code for Radix, while Tailwind and the shadcn CLI
  remain build-time tooling.
- New shadcn components must preserve MarkPDF's existing theme variables or extend the prefixed UI
  tokens rather than renaming application-wide variables.

## Alternatives considered

- **Keep the local CSS tooltip.** Rejected because it duplicated a requested shadcn primitive and
  did not provide Radix's portal and collision behavior.
- **Use Radix Tooltip with hand-written styles.** Rejected because it would keep the interaction
  primitive but discard the requested shadcn component source and styling.
- **Replace the existing settings UI with Tailwind classes.** Rejected because the request concerns
  one reusable primitive, not a renderer-wide styling rewrite.

## Verification

- `tests/e2e/cli-install.spec.ts` focuses and hovers the real info trigger, reads the portalled
  tooltip, and verifies that the tooltip is the topmost painted element above the settings modal.
- `npm run build` verifies the Tailwind, shadcn, React, TypeScript, Electron, CLI, core, and MCP build
  boundaries together.
