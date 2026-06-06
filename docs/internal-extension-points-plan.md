# Internal Extension Points Plan

## Goal

Keep the app future-proof without building a community plugin system.

The useful lesson from Obsidian is not remote plugin loading. It is stable internal registration points: commands, settings pages, panels, document actions, and feature lifecycle cleanup. We can use the same architectural shape inside our own codebase.

## What We Are Not Building

- No community plugin marketplace.
- No loading third-party JavaScript from disk.
- No public plugin API or compatibility promises.
- No plugin packaging format.

## What We Should Build

Create internal registries that app features can contribute to.

Recommended extension points:

- `commands`: actions like open search, open settings, refresh providers.
- `settingsPages`: settings sidebar items and their content views.
- `aiProviders`: provider connection definitions and capabilities.
- `localAgents`: CLI agent detectors and launch metadata.
- `documentActions`: future PDF actions like summarize selection, extract tables, explain page.
- `panels`: future UI panes like chat, inspector, assistant history.

## Obsidian-Inspired Shape

Obsidian plugins can register commands, settings tabs, views, ribbon icons, events, and cleanup handlers. For us, the equivalent should be internal modules that export registration objects.

Example shape:

```ts
export interface AppCommand {
  id: string;
  title: string;
  shortcut?: string;
  run: () => void;
}

export interface SettingsPageRegistration {
  id: string;
  title: string;
  icon: React.ReactNode;
  render: () => React.ReactNode;
}
```

Feature modules would register contributions once, and the app shell would render them.

## Why This Helps

- Keeps `App.tsx` from becoming the permanent owner of every new feature.
- Makes settings and commands additive.
- Lets AI features grow without coupling directly to the PDF reader UI.
- Gives us an obvious place to add chat later without rewriting settings.

## Recommended First Pass

Do the smallest useful version:

- Add a `src/app/commands.ts` command registry.
- Add a `src/settings/settingsRegistry.tsx` registry.
- Register `AI Providers` as the only settings page.
- Wire keyboard shortcuts through the command registry.

This is enough to get the extensibility benefit without introducing actual plugins.

## Difficulty

Medium-low.

This is mostly frontend structure and TypeScript contracts. It becomes harder only if we try to support external plugins, dynamic code loading, or sandboxing. We should avoid that.
