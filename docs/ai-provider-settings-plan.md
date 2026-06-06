# AI Provider Settings Plan

## Goal

Add AI settings, provider management, local server connections, and local CLI agent detection without adding the chat panel yet.

The first deliverable is a settings experience only. The reader UI should not consume these providers beyond toolbar entry points and shortcuts.

## Explicit Scope

Included:

- Settings gear in the app chrome.
- Settings modal or window with a left sidebar.
- `AI Providers` as the only settings page for now.
- Provider records for cloud and local model servers.
- Local OpenAI-compatible connections for LM Studio and Ollama.
- Model discovery and connection validation.
- Local CLI agent detection.
- Enable/disable state for providers and detected agents.
- `Command+K` for search.
- The reserved chat shortcut and toolbar affordance are replaced by Semantic Search.

Excluded for now:

- Chat panel integration.
- Semantic Search implementation details, covered separately in `semantic-search-plan.md`.
- PDF document context sent to models.
- Streaming chat UI.
- Agent execution workflows.
- Community plugin system.

## Architecture

Use a small provider layer behind Electron IPC.

Renderer:

- Settings UI.
- Provider forms.
- Local agent list.
- Validation status.
- Model enable/disable controls.

Electron main:

- Persistent provider store.
- API key storage/masking.
- Provider health checks.
- Model list fetching.
- CLI detection.
- PATH normalization for macOS GUI app launches.

Shared types:

```ts
export type AIProviderKind =
  | "openai-compatible"
  | "openrouter"
  | "ollama"
  | "lmstudio"
  | "anthropic"
  | "custom";

export interface AIProviderConnection {
  id: string;
  kind: AIProviderKind;
  name: string;
  baseUrl: string;
  apiKeyRef?: string;
  enabled: boolean;
  models: AIModelInfo[];
  status: "unknown" | "connected" | "error";
  lastCheckedAt?: string;
}

export interface LocalAgentInfo {
  id: string;
  kind: "codex" | "claude-code" | "gemini-cli" | "custom";
  name: string;
  command: string;
  path?: string;
  available: boolean;
  enabled: boolean;
  version?: string;
}
```

## Provider Store

Start with `electron-store` because the app already uses it.

Store:

- provider metadata
- enabled model IDs
- local agent enablement
- non-secret settings

For secrets, prefer Electron `safeStorage` or OS keychain integration if we want stronger protection. If we keep the first pass simple, store masked display values in settings and keep raw keys in main-process-only storage.

## Local Server Support

LM Studio and Ollama should both be represented as local OpenAI-compatible endpoints where possible.

Defaults:

- Ollama: `http://127.0.0.1:11434`
- LM Studio: `http://127.0.0.1:1234/v1`

Validation:

- Try model list endpoints.
- Accept no API key for local providers.
- Show connection errors directly in settings.
- Allow custom base URL override.

Model discovery:

- OpenAI-compatible: `GET /v1/models`
- Ollama fallback: `GET /api/tags`

## CLI Agent Detection

Detection should run in Electron main, not the renderer.

Initial known commands:

- `codex`
- `claude`
- `gemini`
- `qwen`

Detection steps:

1. Build a reliable PATH.
2. Run `which <command>` or equivalent.
3. Run a lightweight version command when available.
4. Return availability, path, version, and errors.
5. Persist only enable/disable preference, not transient detection output.

macOS note:

Electron apps launched from Finder may not inherit the interactive shell PATH. Detection should include common paths like `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, and `/bin`.

## IPC Surface

Suggested preload API:

```ts
window.pdfReader.ai = {
  listProviders()
  saveProvider(provider)
  deleteProvider(id)
  validateProvider(id)
  fetchProviderModels(id)
  listLocalAgents()
  refreshLocalAgents()
  setLocalAgentEnabled(id, enabled)
}
```

Keep this API settings-focused for now. Do not expose chat completion yet.

## Settings UI

Layout:

- Modal or full-window overlay.
- Left sidebar.
- Right content pane.
- Only `AI Providers` visible initially.

AI Providers page sections:

- Cloud/API providers.
- Local model servers.
- Local CLI agents.
- Add connection button.
- Refresh detected agents button.
- Status badges.

The screenshot direction is good: dense settings page, restrained dark styling, no marketing layout.

## Recommended Stages

1. Settings shell and shortcuts.
2. Provider data model, IPC, persistence.
3. Local server add/test/model discovery.
4. CLI detection and enablement.
5. Provider registry cleanup and tests.
6. Later: document actions consuming this registry.

## Difficulty

Medium.

This is not a full app rewrite. It is an extension if we keep chat out of scope. The risky parts are secure key handling, reliable CLI detection on macOS, and getting provider/model discovery flexible enough for local servers.
