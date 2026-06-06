import {
  Bot,
  CheckCircle2,
  Cloud,
  Cpu,
  Eye,
  KeyRound,
  Plus,
  RefreshCw,
  Server,
  Settings,
  Trash2,
  XCircle
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AIModelInfo, AIProviderInput, AIProviderKind, AIProviderView, LocalAgentInfo } from "./global";

const providerKindLabels: Record<AIProviderKind, string> = {
  "openai-compatible": "OpenAI Compatible",
  openrouter: "OpenRouter",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  anthropic: "Anthropic",
  custom: "Custom"
};

const providerDefaults: Record<AIProviderKind, { name: string; baseUrl: string }> = {
  "openai-compatible": { name: "OpenAI Compatible", baseUrl: "" },
  openrouter: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  ollama: { name: "Ollama", baseUrl: "http://127.0.0.1:11434" },
  lmstudio: { name: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
  anthropic: { name: "Anthropic", baseUrl: "https://api.anthropic.com" },
  custom: { name: "Custom Provider", baseUrl: "" }
};

interface AISettingsDialogProps {
  onClose: () => void;
}

interface ProviderDraft {
  id?: string;
  kind: AIProviderKind;
  name: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  models?: AIModelInfo[];
  existingApiKeyPreview?: string;
}

function draftFromKind(kind: AIProviderKind): ProviderDraft {
  const defaults = providerDefaults[kind];
  return {
    kind,
    name: defaults.name,
    baseUrl: defaults.baseUrl,
    apiKey: "",
    enabled: true
  };
}

function draftFromProvider(provider: AIProviderView): ProviderDraft {
  return {
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey: "",
    enabled: provider.enabled,
    models: provider.models,
    existingApiKeyPreview: provider.apiKeyPreview
  };
}

function formatCheckedAt(value?: string) {
  if (!value) return "Not checked";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

export function AISettingsDialog({ onClose }: AISettingsDialogProps) {
  const [providers, setProviders] = useState<AIProviderView[]>([]);
  const [localAgents, setLocalAgents] = useState<LocalAgentInfo[]>([]);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const enabledModels = useMemo(
    () => providers.reduce((total, provider) => total + provider.models.filter((model) => model.enabled).length, 0),
    [providers]
  );

  const loadProviders = async () => {
    setLoadingProviders(true);
    if (!window.pdfReader?.ai) {
      setProviders([]);
      setLoadingProviders(false);
      return;
    }
    try {
      setProviders(await window.pdfReader.ai.listProviders());
    } finally {
      setLoadingProviders(false);
    }
  };

  const loadAgents = async () => {
    setLoadingAgents(true);
    if (!window.pdfReader?.ai) {
      setLocalAgents([]);
      setLoadingAgents(false);
      return;
    }
    try {
      setLocalAgents(await window.pdfReader.ai.listLocalAgents());
    } finally {
      setLoadingAgents(false);
    }
  };

  useEffect(() => {
    void loadProviders();
    void loadAgents();
  }, []);

  const saveDraft = async (validateAfterSave: boolean) => {
    if (!draft || !window.pdfReader?.ai) return;
    const input: AIProviderInput = {
      id: draft.id,
      kind: draft.kind,
      name: draft.name,
      baseUrl: draft.baseUrl,
      enabled: draft.enabled,
      models: draft.models
    };
    if (draft.apiKey.trim() || !draft.existingApiKeyPreview) {
      input.apiKey = draft.apiKey.trim();
    }

    const saved = await window.pdfReader.ai.saveProvider(input);
    setDraft(null);
    setMessage(validateAfterSave ? "Provider saved. Validating connection..." : "Provider saved.");
    if (validateAfterSave) {
      setBusyProviderId(saved.id);
      const validated = await window.pdfReader.ai.validateProvider(saved.id);
      setBusyProviderId(null);
      setMessage(validated.status === "connected" ? "Provider connected." : validated.error ?? "Provider validation failed.");
    }
    await loadProviders();
  };

  const validateProvider = async (providerId: string) => {
    if (!window.pdfReader?.ai) return;
    setBusyProviderId(providerId);
    const validated = await window.pdfReader.ai.validateProvider(providerId);
    setBusyProviderId(null);
    setMessage(validated.status === "connected" ? "Provider connected." : validated.error ?? "Provider validation failed.");
    await loadProviders();
  };

  const deleteProvider = async (providerId: string) => {
    if (!window.pdfReader?.ai || !window.confirm("Delete this AI provider?")) return;
    await window.pdfReader.ai.deleteProvider(providerId);
    setMessage("Provider deleted.");
    await loadProviders();
  };

  const toggleProvider = async (provider: AIProviderView, enabled: boolean) => {
    if (!window.pdfReader?.ai) return;
    await window.pdfReader.ai.saveProvider({
      id: provider.id,
      kind: provider.kind,
      name: provider.name,
      baseUrl: provider.baseUrl,
      enabled,
      models: provider.models
    });
    await loadProviders();
  };

  const toggleModel = async (provider: AIProviderView, modelId: string, enabled: boolean) => {
    if (!window.pdfReader?.ai) return;
    const models = provider.models.map((model) => (model.id === modelId ? { ...model, enabled } : model));
    await window.pdfReader.ai.saveProvider({
      id: provider.id,
      kind: provider.kind,
      name: provider.name,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      models
    });
    await loadProviders();
  };

  const setAgentEnabled = async (agentId: string, enabled: boolean) => {
    if (!window.pdfReader?.ai) return;
    setLocalAgents(await window.pdfReader.ai.setLocalAgentEnabled(agentId, enabled));
  };

  const refreshAgents = async () => {
    if (!window.pdfReader?.ai) return;
    setLoadingAgents(true);
    try {
      setLocalAgents(await window.pdfReader.ai.refreshLocalAgents());
      setMessage("Local CLI detection refreshed.");
    } finally {
      setLoadingAgents(false);
    }
  };

  return (
    <div className="settings-backdrop" role="presentation">
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <aside className="settings-sidebar">
          <div className="settings-sidebar-title">
            <Settings size={18} />
            <span>Settings</span>
          </div>
          <button className="settings-nav-item active">
            <Bot size={16} />
            <span>AI Providers</span>
          </button>
        </aside>

        <div className="settings-content">
          <header className="settings-header">
            <div>
              <h2 id="settings-title">AI Providers</h2>
              <p>Manage model providers, local servers, and detected CLI agents.</p>
            </div>
            <button className="icon-button" title="Close settings" onClick={onClose}>
              <XCircle size={18} />
            </button>
          </header>

          <div className="settings-summary">
            <span>{providers.length} providers</span>
            <span>{enabledModels} models enabled</span>
            <span>{localAgents.filter((agent) => agent.available && agent.enabled).length} CLI agents enabled</span>
          </div>

          {message && <div className="settings-message">{message}</div>}

          <section className="settings-section">
            <div className="settings-section-heading">
              <div>
                <h3>Model Connections</h3>
                <p>Add OpenRouter, OpenAI-compatible endpoints, Ollama, or LM Studio.</p>
              </div>
              <div className="settings-button-row">
                <button className="secondary-button" onClick={() => setDraft(draftFromKind("ollama"))}>
                  <Server size={15} />
                  Ollama
                </button>
                <button className="secondary-button" onClick={() => setDraft(draftFromKind("lmstudio"))}>
                  <Cpu size={15} />
                  LM Studio
                </button>
                <button className="secondary-button" onClick={() => setDraft(draftFromKind("openrouter"))}>
                  <Cloud size={15} />
                  OpenRouter
                </button>
                <button className="primary-button" onClick={() => setDraft(draftFromKind("openai-compatible"))}>
                  <Plus size={15} />
                  Add
                </button>
              </div>
            </div>

            {draft && (
              <ProviderEditor
                draft={draft}
                onChange={setDraft}
                onCancel={() => setDraft(null)}
                onSave={() => void saveDraft(false)}
                onSaveAndValidate={() => void saveDraft(true)}
              />
            )}

            <div className="provider-list">
              {loadingProviders ? (
                <div className="empty-row">Loading providers...</div>
              ) : providers.length === 0 ? (
                <div className="empty-row">No AI providers configured.</div>
              ) : (
                providers.map((provider) => (
                  <ProviderRow
                    key={provider.id}
                    provider={provider}
                    busy={busyProviderId === provider.id}
                    onEdit={() => setDraft(draftFromProvider(provider))}
                    onDelete={() => void deleteProvider(provider.id)}
                    onValidate={() => void validateProvider(provider.id)}
                    onToggleProvider={(enabled) => void toggleProvider(provider, enabled)}
                    onToggleModel={(modelId, enabled) => void toggleModel(provider, modelId, enabled)}
                  />
                ))
              )}
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section-heading">
              <div>
                <h3>Local CLI Agents</h3>
                <p>Detect installed command-line agents available on this Mac.</p>
              </div>
              <button className="secondary-button" onClick={() => void refreshAgents()}>
                <RefreshCw size={15} />
                Refresh
              </button>
            </div>

            <div className="agent-list">
              {loadingAgents ? (
                <div className="empty-row">Detecting CLI agents...</div>
              ) : (
                localAgents.map((agent) => (
                  <div className="agent-row" key={agent.id}>
                    <div className="agent-main">
                      <span className={`status-dot ${agent.available ? "connected" : "error"}`} />
                      <div>
                        <strong>{agent.name}</strong>
                        <span>{agent.available ? agent.path : agent.error ?? `Command not found: ${agent.command}`}</span>
                      </div>
                    </div>
                    {agent.version && <span className="agent-version">{agent.version}</span>}
                    <label className="switch-control">
                      <input
                        type="checkbox"
                        checked={agent.enabled}
                        disabled={!agent.available}
                        onChange={(event) => void setAgentEnabled(agent.id, event.target.checked)}
                      />
                      <span />
                    </label>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

function ProviderEditor({
  draft,
  onChange,
  onCancel,
  onSave,
  onSaveAndValidate
}: {
  draft: ProviderDraft;
  onChange: (draft: ProviderDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  onSaveAndValidate: () => void;
}) {
  const updateKind = (kind: AIProviderKind) => {
    const defaults = providerDefaults[kind];
    onChange({
      ...draft,
      kind,
      name: draft.id ? draft.name : defaults.name,
      baseUrl: draft.id ? draft.baseUrl : defaults.baseUrl
    });
  };

  return (
    <div className="provider-editor">
      <div className="field-row two">
        <label>
          Provider
          <select value={draft.kind} onChange={(event) => updateKind(event.target.value as AIProviderKind)}>
            {Object.entries(providerKindLabels).map(([value, label]) => (
              <option value={value} key={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name
          <input value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
        </label>
      </div>
      <label>
        Base URL
        <input
          value={draft.baseUrl}
          placeholder={providerDefaults[draft.kind].baseUrl || "https://api.example.com/v1"}
          onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })}
        />
      </label>
      <div className="field-row two">
        <label>
          API Key
          <input
            type="password"
            value={draft.apiKey}
            placeholder={draft.existingApiKeyPreview ? `Stored: ${draft.existingApiKeyPreview}` : "Optional for local servers"}
            onChange={(event) => onChange({ ...draft, apiKey: event.target.value })}
          />
        </label>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
          />
          Enabled
        </label>
      </div>
      <div className="modal-actions">
        <button className="secondary-button" onClick={onCancel}>
          Cancel
        </button>
        <button className="secondary-button" onClick={onSave}>
          Save
        </button>
        <button className="primary-button" onClick={onSaveAndValidate}>
          Save & Validate
        </button>
      </div>
    </div>
  );
}

function ProviderRow({
  provider,
  busy,
  onEdit,
  onDelete,
  onValidate,
  onToggleProvider,
  onToggleModel
}: {
  provider: AIProviderView;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onValidate: () => void;
  onToggleProvider: (enabled: boolean) => void;
  onToggleModel: (modelId: string, enabled: boolean) => void;
}) {
  const visibleModels = provider.models.slice(0, 8);
  return (
    <article className="provider-row">
      <div className="provider-row-header">
        <div className="provider-title">
          <span className={`status-dot ${provider.status}`} />
          <div>
            <strong>{provider.name}</strong>
            <span>{providerKindLabels[provider.kind]} · {provider.baseUrl || "No base URL"}</span>
          </div>
        </div>
        <div className="provider-actions">
          {provider.hasApiKey && (
            <span className="api-key-chip">
              <KeyRound size={13} />
              {provider.apiKeyPreview}
            </span>
          )}
          <label className="switch-control" title="Enable provider">
            <input type="checkbox" checked={provider.enabled} onChange={(event) => onToggleProvider(event.target.checked)} />
            <span />
          </label>
          <button className="secondary-button" disabled={busy} onClick={onValidate}>
            {busy ? <RefreshCw size={15} /> : <CheckCircle2 size={15} />}
            Validate
          </button>
          <button className="icon-button" title="Edit provider" onClick={onEdit}>
            <Eye size={16} />
          </button>
          <button className="icon-button danger-icon" title="Delete provider" onClick={onDelete}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>
      <div className="provider-meta">
        <span>{provider.status === "connected" ? "Connected" : provider.status === "error" ? "Error" : "Unknown"}</span>
        <span>{formatCheckedAt(provider.lastCheckedAt)}</span>
        {provider.error && <span className="provider-error">{provider.error}</span>}
      </div>
      {provider.models.length > 0 && (
        <div className="model-list">
          {visibleModels.map((model) => (
            <label className="model-row" key={model.id}>
              <span>{model.name}</span>
              <span className="switch-control small">
                <input type="checkbox" checked={model.enabled} onChange={(event) => onToggleModel(model.id, event.target.checked)} />
                <span />
              </span>
            </label>
          ))}
          {provider.models.length > visibleModels.length && <span className="models-more">+{provider.models.length - visibleModels.length} more models</span>}
        </div>
      )}
    </article>
  );
}
