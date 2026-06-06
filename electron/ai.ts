import { safeStorage } from "electron";
import Store from "electron-store";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AIProviderKind = "openai-compatible" | "openrouter" | "ollama" | "lmstudio" | "anthropic" | "custom";

export interface AIModelInfo {
  id: string;
  name: string;
  enabled: boolean;
}

export interface AIProviderRecord {
  id: string;
  kind: AIProviderKind;
  name: string;
  baseUrl: string;
  encryptedApiKey?: string;
  enabled: boolean;
  models: AIModelInfo[];
  status: "unknown" | "connected" | "error";
  error?: string;
  lastCheckedAt?: string;
}

export interface AIProviderView {
  id: string;
  kind: AIProviderKind;
  name: string;
  baseUrl: string;
  enabled: boolean;
  models: AIModelInfo[];
  status: "unknown" | "connected" | "error";
  error?: string;
  lastCheckedAt?: string;
  hasApiKey: boolean;
  apiKeyPreview?: string;
}

export interface AIProviderInput {
  id?: string;
  kind: AIProviderKind;
  name: string;
  baseUrl: string;
  apiKey?: string;
  enabled: boolean;
  models?: AIModelInfo[];
}

export interface LocalAgentInfo {
  id: string;
  kind: "codex" | "claude-code" | "gemini-cli" | "qwen-cli";
  name: string;
  command: string;
  path?: string;
  available: boolean;
  enabled: boolean;
  version?: string;
  error?: string;
}

export interface AIStoreSchema {
  recentFiles: string[];
  aiProviders: AIProviderRecord[];
  localAgentEnabled: Record<string, boolean>;
}

const knownLocalAgents: Array<Omit<LocalAgentInfo, "available" | "enabled"> & { versionArgs: string[] }> = [
  { id: "codex", kind: "codex", name: "Codex CLI", command: "codex", versionArgs: ["--version"] },
  { id: "claude-code", kind: "claude-code", name: "Claude Code", command: "claude", versionArgs: ["--version"] },
  { id: "gemini-cli", kind: "gemini-cli", name: "Gemini CLI", command: "gemini", versionArgs: ["--version"] },
  { id: "qwen-cli", kind: "qwen-cli", name: "Qwen CLI", command: "qwen", versionArgs: ["--version"] }
];

function defaultPathEnv() {
  const segments = [
    process.env.PATH,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(":"));
  return [...new Set(segments)].join(":");
}

function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function providerDefaults(kind: AIProviderKind) {
  if (kind === "ollama") return { name: "Ollama", baseUrl: "http://127.0.0.1:11434" };
  if (kind === "lmstudio") return { name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" };
  if (kind === "openrouter") return { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" };
  if (kind === "anthropic") return { name: "Anthropic", baseUrl: "https://api.anthropic.com" };
  return { name: "OpenAI Compatible", baseUrl: "" };
}

function encryptApiKey(apiKey: string) {
  if (!apiKey) return undefined;
  if (safeStorage.isEncryptionAvailable()) {
    return `safe:${safeStorage.encryptString(apiKey).toString("base64")}`;
  }
  return `plain:${Buffer.from(apiKey, "utf8").toString("base64")}`;
}

function decryptApiKey(value?: string) {
  if (!value) return "";
  try {
    if (value.startsWith("safe:")) {
      return safeStorage.decryptString(Buffer.from(value.slice(5), "base64"));
    }
    if (value.startsWith("plain:")) {
      return Buffer.from(value.slice(6), "base64").toString("utf8");
    }
  } catch {
    return "";
  }
  return "";
}

function maskApiKey(apiKey: string) {
  if (!apiKey) return undefined;
  if (apiKey.length <= 8) return "***";
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

function toProviderView(provider: AIProviderRecord): AIProviderView {
  const apiKey = decryptApiKey(provider.encryptedApiKey);
  return {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled,
    models: provider.models,
    status: provider.status,
    error: provider.error,
    lastCheckedAt: provider.lastCheckedAt,
    hasApiKey: Boolean(apiKey),
    apiKeyPreview: maskApiKey(apiKey)
  };
}

function parseOpenAIModels(payload: unknown): AIModelInfo[] {
  const data = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const id = (item as { id?: unknown }).id;
      return typeof id === "string" ? { id, name: id, enabled: true } : null;
    })
    .filter((item): item is AIModelInfo => Boolean(item));
}

function parseOllamaModels(payload: unknown): AIModelInfo[] {
  const models = payload && typeof payload === "object" ? (payload as { models?: unknown }).models : undefined;
  if (!Array.isArray(models)) return [];
  return models
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const name = (item as { name?: unknown; model?: unknown }).name ?? (item as { model?: unknown }).model;
      return typeof name === "string" ? { id: name, name, enabled: true } : null;
    })
    .filter((item): item is AIModelInfo => Boolean(item));
}

async function fetchJson(url: string, apiKey: string, extraHeaders: Record<string, string> = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...extraHeaders
    },
    signal: AbortSignal.timeout(8000)
  });

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}${text ? `: ${String(text).slice(0, 180)}` : ""}`);
  }
  return payload;
}

async function discoverProviderModels(provider: AIProviderRecord): Promise<AIModelInfo[]> {
  const baseUrl = normalizeBaseUrl(provider.baseUrl || providerDefaults(provider.kind).baseUrl);
  const apiKey = decryptApiKey(provider.encryptedApiKey);

  if (!baseUrl) {
    throw new Error("Base URL is required.");
  }

  if (provider.kind === "ollama") {
    try {
      const payload = await fetchJson(`${baseUrl}/api/tags`, "");
      return parseOllamaModels(payload);
    } catch {
      const payload = await fetchJson(`${baseUrl}/v1/models`, apiKey);
      return parseOpenAIModels(payload);
    }
  }

  if (provider.kind === "anthropic") {
    if (!apiKey) throw new Error("API key is required.");
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey
      },
      body: JSON.stringify({
        model: "claude-3-haiku-20240307",
        max_tokens: 1,
        messages: [{ role: "user", content: "test" }]
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (response.status === 401 || response.status === 403) throw new Error(`HTTP ${response.status}: authentication failed`);
    return provider.models.length ? provider.models : [{ id: "claude", name: "Claude", enabled: true }];
  }

  const payload = await fetchJson(`${baseUrl}/models`, apiKey).catch(() => fetchJson(`${baseUrl}/v1/models`, apiKey));
  return parseOpenAIModels(payload);
}

function mergeModelEnabledState(nextModels: AIModelInfo[], previousModels: AIModelInfo[]) {
  const previous = new Map(previousModels.map((model) => [model.id, model.enabled]));
  return nextModels.map((model) => ({
    ...model,
    enabled: previous.get(model.id) ?? model.enabled
  }));
}

function getProviders(store: Store<AIStoreSchema>) {
  return store.get("aiProviders", []);
}

function setProviders(store: Store<AIStoreSchema>, providers: AIProviderRecord[]) {
  store.set("aiProviders", providers);
}

export function listAIProviders(store: Store<AIStoreSchema>) {
  return getProviders(store).map(toProviderView);
}

export function saveAIProvider(store: Store<AIStoreSchema>, input: AIProviderInput) {
  const providers = getProviders(store);
  const existing = input.id ? providers.find((provider) => provider.id === input.id) : undefined;
  const defaults = providerDefaults(input.kind);
  const trimmedApiKey = input.apiKey?.trim();
  const provider: AIProviderRecord = {
    id: existing?.id ?? `provider-${crypto.randomUUID()}`,
    kind: input.kind,
    name: input.name.trim() || defaults.name,
    baseUrl: normalizeBaseUrl(input.baseUrl || defaults.baseUrl),
    encryptedApiKey:
      trimmedApiKey !== undefined
        ? trimmedApiKey
          ? encryptApiKey(trimmedApiKey)
          : undefined
        : existing?.encryptedApiKey,
    enabled: input.enabled,
    models: input.models ?? existing?.models ?? [],
    status: existing?.status ?? "unknown",
    error: existing?.error,
    lastCheckedAt: existing?.lastCheckedAt
  };

  const nextProviders = existing
    ? providers.map((item) => (item.id === existing.id ? provider : item))
    : [...providers, provider];
  setProviders(store, nextProviders);
  return toProviderView(provider);
}

export function deleteAIProvider(store: Store<AIStoreSchema>, id: string) {
  setProviders(
    store,
    getProviders(store).filter((provider) => provider.id !== id)
  );
}

export async function validateAIProvider(store: Store<AIStoreSchema>, id: string) {
  const providers = getProviders(store);
  const provider = providers.find((item) => item.id === id);
  if (!provider) throw new Error("Provider not found.");

  try {
    const models = await discoverProviderModels(provider);
    const updated: AIProviderRecord = {
      ...provider,
      models: mergeModelEnabledState(models, provider.models),
      status: "connected",
      error: undefined,
      lastCheckedAt: new Date().toISOString()
    };
    setProviders(store, providers.map((item) => (item.id === id ? updated : item)));
    return toProviderView(updated);
  } catch (error) {
    const updated: AIProviderRecord = {
      ...provider,
      status: "error",
      error: error instanceof Error ? error.message : "Connection failed.",
      lastCheckedAt: new Date().toISOString()
    };
    setProviders(store, providers.map((item) => (item.id === id ? updated : item)));
    return toProviderView(updated);
  }
}

async function commandPath(command: string) {
  const executable = process.platform === "win32" ? "where" : "/bin/zsh";
  const args = process.platform === "win32" ? [command] : ["-lc", `command -v ${command}`];
  const { stdout } = await execFileAsync(executable, args, {
    env: { ...process.env, PATH: defaultPathEnv() },
    timeout: 5000
  });
  return stdout.trim().split("\n")[0] || undefined;
}

async function commandVersion(path: string, args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(path, args, {
      env: { ...process.env, PATH: defaultPathEnv() },
      shell: process.platform === "win32",
      timeout: 5000
    });
    return (stdout || stderr).trim().split("\n")[0]?.slice(0, 120);
  } catch {
    return undefined;
  }
}

export async function detectLocalAgents(store: Store<AIStoreSchema>) {
  const enabledMap = store.get("localAgentEnabled", {});

  const agents = await Promise.all(
    knownLocalAgents.map(async (agent) => {
      try {
        const path = await commandPath(agent.command);
        const version = path ? await commandVersion(path, agent.versionArgs) : undefined;
        return {
          id: agent.id,
          kind: agent.kind,
          name: agent.name,
          command: agent.command,
          path,
          available: Boolean(path),
          enabled: enabledMap[agent.id] ?? Boolean(path),
          version
        } satisfies LocalAgentInfo;
      } catch (error) {
        return {
          id: agent.id,
          kind: agent.kind,
          name: agent.name,
          command: agent.command,
          available: false,
          enabled: enabledMap[agent.id] ?? false,
          error: error instanceof Error ? error.message : "Detection failed."
        } satisfies LocalAgentInfo;
      }
    })
  );

  return agents;
}

export function setLocalAgentEnabled(store: Store<AIStoreSchema>, id: string, enabled: boolean) {
  const current = store.get("localAgentEnabled", {});
  store.set("localAgentEnabled", { ...current, [id]: enabled });
}
