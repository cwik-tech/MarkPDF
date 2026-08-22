import {
  Bot,
  CheckCircle2,
  Eye,
  FileText,
  KeyRound,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  XCircle
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  AIModelInfo,
  AIProviderInput,
  AIProviderKind,
  AIProviderView,
  DefaultAppFileTypeId,
  DefaultAppStatus,
  LocalAgentInfo,
  MarkdownExportSettings,
  SemanticDatabaseInfo,
  SemanticSearchSettings
} from "./global";
import { clearSemanticIndex, downloadSemanticModel } from "./semanticIndex";
import {
  chunkingPresets,
  curatedEmbeddingModels,
  defaultSemanticScoreThreshold,
  legacyRecommendedEmbeddingModelId,
  recommendedEmbeddingModelId,
  semanticScoreThresholdPresets
} from "./semanticModels";

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
  onSemanticSettingsChange?: (settings: SemanticSearchSettings) => void;
  onSemanticIndexCleared?: () => void;
}

type SettingsPage = "general" | "providers" | "semantic" | "markdown";

const emptyDefaultAppStatus: DefaultAppStatus = {
  supported: false,
  bundleId: null,
  bundlePath: null,
  fileTypes: []
};

const defaultSemanticSettings: SemanticSearchSettings = {
  enabled: true,
  activeModelId: recommendedEmbeddingModelId,
  chunkingProfile: "balanced",
  minSemanticScore: defaultSemanticScoreThreshold,
  downloadedModelIds: []
};

const defaultMarkdownSettings: MarkdownExportSettings = {
  defaultEngine: "auto",
  exportMode: "readable",
  includePageMarkers: true,
  useOcrFallback: true,
  includeAnnotations: true,
  includeImageDescriptions: true,
  aiCleanup: false,
  engineSelectionExplicit: false
};

function markdownEngineLabel(engine: MarkdownExportSettings["defaultEngine"]) {
  if (engine === "auto") return "Auto";
  if (engine === "docling-vlm-smoldocling") return "Docling VLM (SmolDocling)";
  return engine === "docling-managed" ? "Docling" : "Basic text extraction";
}

function normalizeSemanticSettings(settings: SemanticSearchSettings): SemanticSearchSettings {
  const curatedModelIds = new Set(curatedEmbeddingModels.map((model) => model.id));
  const activeModelId =
    settings.activeModelId === legacyRecommendedEmbeddingModelId || !curatedModelIds.has(settings.activeModelId)
      ? recommendedEmbeddingModelId
      : settings.activeModelId;

  return {
    ...settings,
    activeModelId,
    minSemanticScore:
      typeof settings.minSemanticScore === "number" && Number.isFinite(settings.minSemanticScore)
        ? Math.min(0.95, Math.max(0, settings.minSemanticScore))
        : defaultSemanticScoreThreshold,
    downloadedModelIds: settings.downloadedModelIds.filter((modelId) => curatedModelIds.has(modelId))
  };
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

export function AISettingsDialog({ onClose, onSemanticSettingsChange, onSemanticIndexCleared }: AISettingsDialogProps) {
  const [page, setPage] = useState<SettingsPage>("general");
  const [defaultAppStatus, setDefaultAppStatus] = useState<DefaultAppStatus>(emptyDefaultAppStatus);
  const [busyDefaultAppFileTypeId, setBusyDefaultAppFileTypeId] = useState<DefaultAppFileTypeId | "all" | null>(null);
  const [providers, setProviders] = useState<AIProviderView[]>([]);
  const [localAgents, setLocalAgents] = useState<LocalAgentInfo[]>([]);
  const [semanticSettings, setSemanticSettings] = useState<SemanticSearchSettings>(defaultSemanticSettings);
  const [markdownSettings, setMarkdownSettings] = useState<MarkdownExportSettings>(defaultMarkdownSettings);
  const [databaseInfo, setDatabaseInfo] = useState<SemanticDatabaseInfo>({ sizeBytes: 0 });
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [loadingAgents, setLoadingAgents] = useState(true);
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null);
  const [busySemanticModelId, setBusySemanticModelId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null);

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

  const loadSemanticSettings = async () => {
    if (!window.pdfReader?.semantic) return;
    const settings = await window.pdfReader.semantic.getSettings();
    const normalizedSettings = normalizeSemanticSettings(settings);
    setSemanticSettings(normalizedSettings);
    if (
      normalizedSettings.activeModelId !== settings.activeModelId ||
      normalizedSettings.minSemanticScore !== settings.minSemanticScore ||
      normalizedSettings.downloadedModelIds.length !== settings.downloadedModelIds.length
    ) {
      await window.pdfReader.semantic.saveSettings(normalizedSettings);
    }
    setDatabaseInfo(await window.pdfReader.semantic.databaseInfo());
  };

  const loadMarkdownSettings = async () => {
    if (!window.pdfReader?.markdown) return;
    setMarkdownSettings(await window.pdfReader.markdown.getSettings());
  };

  const loadDefaultAppStatus = async () => {
    if (!window.pdfReader?.defaultApp) {
      setDefaultAppStatus(emptyDefaultAppStatus);
      return;
    }
    setDefaultAppStatus(await window.pdfReader.defaultApp.getStatus());
  };

  useEffect(() => {
    void loadProviders();
    void loadAgents();
    void loadSemanticSettings();
    void loadMarkdownSettings();
    void loadDefaultAppStatus();
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const showToast = (message: string) => {
    setToast({ id: Date.now(), message });
  };

  const setAsDefaultApp = async (fileTypeIds: DefaultAppFileTypeId[], busyKey: DefaultAppFileTypeId | "all") => {
    if (!window.pdfReader?.defaultApp) return;
    setBusyDefaultAppFileTypeId(busyKey);
    try {
      const status = await window.pdfReader.defaultApp.setAsDefault(fileTypeIds);
      setDefaultAppStatus(status);
      const pending = status.fileTypes.filter((fileType) => fileTypeIds.includes(fileType.id) && !fileType.isDefault);
      if (pending.length === 0) {
        showToast(fileTypeIds.length > 1 ? "MarkPDF is now the default app for these files." : "MarkPDF is now the default app.");
      } else {
        showToast(status.reason ?? `macOS did not apply the change for ${pending.map((fileType) => fileType.label).join(", ")}.`);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not change the default application.");
    } finally {
      setBusyDefaultAppFileTypeId(null);
    }
  };

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
    showToast(validateAfterSave ? "Provider saved. Validating connection..." : "Provider saved.");
    if (validateAfterSave) {
      setBusyProviderId(saved.id);
      const validated = await window.pdfReader.ai.validateProvider(saved.id);
      setBusyProviderId(null);
      showToast(validated.status === "connected" ? "Provider connected." : validated.error ?? "Provider validation failed.");
    }
    await loadProviders();
  };

  const validateProvider = async (providerId: string) => {
    if (!window.pdfReader?.ai) return;
    setBusyProviderId(providerId);
    const validated = await window.pdfReader.ai.validateProvider(providerId);
    setBusyProviderId(null);
    showToast(validated.status === "connected" ? "Provider connected." : validated.error ?? "Provider validation failed.");
    await loadProviders();
  };

  const deleteProvider = async (providerId: string) => {
    if (!window.pdfReader?.ai || !window.confirm("Delete this AI provider?")) return;
    await window.pdfReader.ai.deleteProvider(providerId);
    showToast("Provider deleted.");
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
      showToast("Local CLI detection refreshed.");
    } finally {
      setLoadingAgents(false);
    }
  };

  const saveSemanticSettings = async (patch: Partial<SemanticSearchSettings>) => {
    if (!window.pdfReader?.semantic) return;
    const nextSettings = normalizeSemanticSettings(await window.pdfReader.semantic.saveSettings(patch));
    setSemanticSettings(nextSettings);
    onSemanticSettingsChange?.(nextSettings);
    showToast("Semantic search settings saved.");
  };

  const saveMarkdownSettings = async (patch: Partial<MarkdownExportSettings>) => {
    if (!window.pdfReader?.markdown) return;
    const nextSettings = await window.pdfReader.markdown.saveSettings(patch);
    setMarkdownSettings(nextSettings);
    showToast("Markdown settings saved.");
  };

  const downloadModel = async (modelId: string) => {
    setBusySemanticModelId(modelId);
    try {
      const settings = await downloadSemanticModel(modelId, (progress) => {
        if (progress.status === "downloading" && progress.current && progress.total) {
          const percent = Math.round((progress.current / progress.total) * 100);
          showToast(`Downloading model ${percent}%`);
        }
      });
      if (settings) {
        setSemanticSettings(settings);
        onSemanticSettingsChange?.(settings);
      }
      showToast("Embedding model ready.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Model download failed.");
    } finally {
      setBusySemanticModelId(null);
      await loadSemanticSettings();
    }
  };

  const removeModel = async (modelId: string) => {
    if (!window.pdfReader?.semantic) return;
    const nextSettings = await window.pdfReader.semantic.removeModel(modelId);
    setSemanticSettings(nextSettings);
    onSemanticSettingsChange?.(nextSettings);
    showToast("Model removed from downloaded list.");
  };

  const clearIndex = async () => {
    if (!window.confirm("Clear the local semantic index? PDFs and downloaded models will not be deleted.")) return;
    await clearSemanticIndex();
    await loadSemanticSettings();
    onSemanticIndexCleared?.();
    showToast("Semantic index cleared.");
  };

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        {toast && (
          <div className="settings-toast" role="status">
            <span>{toast.message}</span>
            <button className="toast-close-button" title="Dismiss" onClick={() => setToast(null)}>
              <XCircle size={14} />
            </button>
          </div>
        )}
        <aside className="settings-sidebar">
          <div className="settings-sidebar-title">
            <Settings size={18} />
            <span>Settings</span>
          </div>
          <button className={`settings-nav-item ${page === "general" ? "active" : ""}`} onClick={() => setPage("general")}>
            <SlidersHorizontal size={16} />
            <span>General</span>
          </button>
          <button className={`settings-nav-item ${page === "providers" ? "active" : ""}`} onClick={() => setPage("providers")}>
            <Bot size={16} />
            <span>AI Providers</span>
          </button>
          <button className={`settings-nav-item ${page === "semantic" ? "active" : ""}`} onClick={() => setPage("semantic")}>
            <Search size={16} />
            <span>Semantic Search</span>
          </button>
          <button className={`settings-nav-item ${page === "markdown" ? "active" : ""}`} onClick={() => setPage("markdown")}>
            <FileText size={16} />
            <span>Markdown</span>
          </button>
        </aside>

        <div className="settings-content">
          <header className="settings-header">
            <div>
              <h2 id="settings-title">
                {page === "general"
                  ? "General"
                  : page === "providers"
                    ? "AI Providers"
                    : page === "semantic"
                      ? "Semantic Search"
                      : "Markdown"}
              </h2>
              <p>
                {page === "general"
                  ? "Choose which files macOS opens with MarkPDF."
                  : page === "providers"
                    ? "Manage model providers, local servers, and detected CLI agents."
                    : page === "semantic"
                      ? "Manage local embedding models and the private document index."
                      : "Manage Markdown export behavior and conversion defaults."}
              </p>
            </div>
            <button className="icon-button" title="Close settings" onClick={onClose}>
              <XCircle size={18} />
            </button>
          </header>

          {page === "general" ? (
            <div className="settings-summary">
              {!defaultAppStatus.supported ? (
                <span>Default app changes unavailable</span>
              ) : (
                defaultAppStatus.fileTypes.map((fileType) => (
                  <span key={fileType.id}>
                    {fileType.description}: {fileType.isDefault ? "MarkPDF" : fileType.currentAppName ?? "not set"}
                  </span>
                ))
              )}
            </div>
          ) : page === "providers" ? (
            <div className="settings-summary">
              <span>{providers.length} providers</span>
              <span>{enabledModels} models enabled</span>
              <span>{localAgents.filter((agent) => agent.available && agent.enabled).length} CLI agents enabled</span>
            </div>
          ) : page === "semantic" ? (
            <div className="settings-summary">
              <span>{semanticSettings.enabled ? "Enabled" : "Disabled"}</span>
              <span>{semanticSettings.downloadedModelIds.length} models downloaded</span>
              <span>{formatBytes(databaseInfo.sizeBytes)} index</span>
            </div>
          ) : (
            <div className="settings-summary">
              <span>{markdownSettings.exportMode === "readable" ? "Readable" : "Page preserving"}</span>
              <span>{markdownSettings.useOcrFallback ? "OCR fallback" : "PDF text only"}</span>
              <span>{markdownSettings.includeAnnotations ? "Annotations included" : "Annotations off"}</span>
            </div>
          )}

          {page === "general" && (
            <GeneralSettingsPage
              status={defaultAppStatus}
              busyFileTypeId={busyDefaultAppFileTypeId}
              onRefresh={() => void loadDefaultAppStatus()}
              onSetDefault={(fileTypeIds, busyKey) => void setAsDefaultApp(fileTypeIds, busyKey)}
            />
          )}

          {page === "providers" && (
            <>
          <section className="settings-section">
            <div className="settings-section-heading">
              <div>
                <h3>Model Connections</h3>
                <p>Add OpenRouter, OpenAI-compatible endpoints, Ollama, or LM Studio.</p>
              </div>
              <div className="settings-button-row">
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
            </>
          )}

          {page === "semantic" && (
            <SemanticSettingsPage
              settings={semanticSettings}
              databaseInfo={databaseInfo}
              busyModelId={busySemanticModelId}
              onToggleEnabled={(enabled) => void saveSemanticSettings({ enabled })}
              onSelectModel={(activeModelId) => void saveSemanticSettings({ activeModelId })}
              onSelectChunkingProfile={(chunkingProfile) => void saveSemanticSettings({ chunkingProfile })}
              onSelectMinSemanticScore={(minSemanticScore) => void saveSemanticSettings({ minSemanticScore })}
              onDownload={(modelId) => void downloadModel(modelId)}
              onRemoveModel={(modelId) => void removeModel(modelId)}
              onClearIndex={() => void clearIndex()}
            />
          )}

          {page === "markdown" && (
            <MarkdownSettingsPage
              settings={markdownSettings}
              onChange={(patch) => void saveMarkdownSettings(patch)}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function GeneralSettingsPage({
  status,
  busyFileTypeId,
  onRefresh,
  onSetDefault
}: {
  status: DefaultAppStatus;
  busyFileTypeId: DefaultAppFileTypeId | "all" | null;
  onRefresh: () => void;
  onSetDefault: (fileTypeIds: DefaultAppFileTypeId[], busyKey: DefaultAppFileTypeId | "all") => void;
}) {
  const missing = status.fileTypes.filter((fileType) => !fileType.isDefault);
  const busy = busyFileTypeId !== null;

  return (
    <section className="settings-section">
      <div className="settings-section-heading">
        <div>
          <h3>Default Application</h3>
          <p>Pick the file types that open in MarkPDF when you double-click them in Finder.</p>
        </div>
        <button className="secondary-button" disabled={busy} onClick={onRefresh}>
          <RefreshCw size={15} />
          Refresh
        </button>
      </div>

      {!status.supported && status.reason && <p className="settings-note">{status.reason}</p>}

      <div className="agent-list">
        {status.fileTypes.length === 0 ? (
          <div className="empty-row">No file types available.</div>
        ) : (
          status.fileTypes.map((fileType) => (
            <div className="agent-row" key={fileType.id}>
              <div className="agent-main">
                <span className={`status-dot ${fileType.isDefault ? "connected" : ""}`} />
                <div>
                  <strong>{fileType.label}</strong>
                  <span>
                    {!status.supported
                      ? fileType.description
                      : fileType.isDefault
                        ? `${fileType.description} — opens in MarkPDF`
                        : fileType.currentAppName
                          ? `${fileType.description} — opens in ${fileType.currentAppName}`
                          : `${fileType.description} — no default app set`}
                  </span>
                </div>
              </div>
              {fileType.isDefault ? (
                <span className="default-app-badge">
                  <CheckCircle2 size={14} />
                  Default
                </span>
              ) : (
                <button
                  className="secondary-button"
                  disabled={!status.supported || busy}
                  onClick={() => onSetDefault([fileType.id], fileType.id)}
                >
                  {busyFileTypeId === fileType.id ? "Setting..." : "Set as default"}
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {status.supported && missing.length > 1 && (
        <div className="settings-section-heading">
          <p className="settings-note">MarkPDF is not the default app for {missing.length} of these file types.</p>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => onSetDefault(missing.map((fileType) => fileType.id), "all")}
          >
            {busyFileTypeId === "all" ? "Setting..." : "Set as default for all"}
          </button>
        </div>
      )}
    </section>
  );
}

function MarkdownSettingsPage({
  settings,
  onChange
}: {
  settings: MarkdownExportSettings;
  onChange: (patch: Partial<MarkdownExportSettings>) => void;
}) {
  return (
    <>
      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h3>Conversion Engine</h3>
            <p>Choose the default PDF to Markdown conversion path.</p>
          </div>
        </div>
        <div className="provider-editor">
          <label>
            Default engine
            <select value={settings.defaultEngine} onChange={(event) => onChange({ defaultEngine: event.target.value as MarkdownExportSettings["defaultEngine"] })}>
              <option value="auto">Auto</option>
              <option value="docling-managed">Docling standard</option>
              <option value="docling-vlm-smoldocling">Docling VLM (SmolDocling)</option>
              <option value="builtin-text">Basic text extraction</option>
            </select>
          </label>
        </div>
        <div className="settings-summary markdown-engine-summary">
          <span>
            <strong>Default engine</strong>
            {markdownEngineLabel(settings.defaultEngine)}
          </span>
          <span>
            <strong>Fallback engine</strong>
            Basic text extraction
          </span>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h3>Output</h3>
            <p>Control Markdown structure and readability.</p>
          </div>
        </div>
        <div className="provider-editor">
          <label>
            Export mode
            <select value={settings.exportMode} onChange={(event) => onChange({ exportMode: event.target.value as MarkdownExportSettings["exportMode"] })}>
              <option value="readable">Readable Markdown</option>
              <option value="page-preserving">Page-preserving Markdown</option>
            </select>
          </label>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h3>Content</h3>
            <p>Control what the export includes.</p>
          </div>
        </div>
        <div className="agent-list">
          <MarkdownToggle
            title="Include page markers"
            description="Adds page headings so Markdown can be traced back to the PDF."
            checked={settings.includePageMarkers}
            onChange={(includePageMarkers) => onChange({ includePageMarkers })}
          />
          <MarkdownToggle
            title="Use OCR fallback"
            description="Uses OCR text when a page has little or no PDF text layer."
            checked={settings.useOcrFallback}
            onChange={(useOcrFallback) => onChange({ useOcrFallback })}
          />
          <MarkdownToggle
            title="Include annotations"
            description="Adds exported text, comment, highlight, and signature notes."
            checked={settings.includeAnnotations}
            onChange={(includeAnnotations) => onChange({ includeAnnotations })}
          />
          <MarkdownToggle
            title="Describe images"
            description="Adds locally generated descriptions below exported images."
            checked={settings.includeImageDescriptions}
            onChange={(includeImageDescriptions) => onChange({ includeImageDescriptions })}
          />
          <MarkdownToggle
            title="AI cleanup"
            description="Reserved for future provider-backed Markdown cleanup."
            checked={settings.aiCleanup}
            disabled
            onChange={(aiCleanup) => onChange({ aiCleanup })}
          />
        </div>
      </section>
    </>
  );
}

function MarkdownToggle({
  title,
  description,
  checked,
  disabled,
  onChange
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="agent-row">
      <div className="agent-main">
        <span className={`status-dot ${checked ? "connected" : "unknown"}`} />
        <div>
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
      </div>
      <label className="switch-control">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
        <span />
      </label>
    </div>
  );
}

function SemanticSettingsPage({
  settings,
  databaseInfo,
  busyModelId,
  onToggleEnabled,
  onSelectModel,
  onSelectChunkingProfile,
  onSelectMinSemanticScore,
  onDownload,
  onRemoveModel,
  onClearIndex
}: {
  settings: SemanticSearchSettings;
  databaseInfo: SemanticDatabaseInfo;
  busyModelId: string | null;
  onToggleEnabled: (enabled: boolean) => void;
  onSelectModel: (modelId: string) => void;
  onSelectChunkingProfile: (profile: SemanticSearchSettings["chunkingProfile"]) => void;
  onSelectMinSemanticScore: (score: number) => void;
  onDownload: (modelId: string) => void;
  onRemoveModel: (modelId: string) => void;
  onClearIndex: () => void;
}) {
  return (
    <>
      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h3>Local Indexing</h3>
            <p>Runs locally. PDF text and search queries are not sent to AI providers.</p>
          </div>
          <label className="switch-control" title="Enable semantic search">
            <input type="checkbox" checked={settings.enabled} onChange={(event) => onToggleEnabled(event.target.checked)} />
            <span />
          </label>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h3>Embedding Models</h3>
            <p>Download multiple curated models, but use only one at a time.</p>
          </div>
        </div>
        <div className="provider-list">
          {curatedEmbeddingModels.map((model) => {
            const downloaded = settings.downloadedModelIds.includes(model.id);
            const active = settings.activeModelId === model.id;
            return (
              <article className="provider-row" key={model.id}>
                <div className="provider-row-header">
                  <div className="provider-title">
                    <span className={`status-dot ${downloaded ? "connected" : "unknown"}`} />
                    <div>
                      <strong>{model.name}</strong>
                      <span>
                        {model.dimensions} dimensions · about {model.approxSizeMb} MB · {model.description}
                      </span>
                    </div>
                  </div>
                  <div className="provider-actions">
                    {model.badge && <span className="api-key-chip">{model.badge}</span>}
                    <button className={`secondary-button ${active ? "active-model-button" : ""}`} disabled={active} onClick={() => onSelectModel(model.id)}>
                      {active ? "Active" : "Use"}
                    </button>
                    {downloaded ? (
                      <button className="secondary-button" onClick={() => onRemoveModel(model.id)}>
                        Remove
                      </button>
                    ) : (
                      <button className="primary-button" disabled={busyModelId === model.id} onClick={() => onDownload(model.id)}>
                        {busyModelId === model.id ? <RefreshCw size={15} /> : <Plus size={15} />}
                        Download
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h3>Document Index</h3>
            <p>Clearing the index does not delete PDFs or downloaded models.</p>
          </div>
          <button className="secondary-button danger-button" onClick={onClearIndex}>
            <Trash2 size={15} />
            Clear Index
          </button>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h3>Advanced</h3>
            <p>Changing chunking requires documents to be indexed again.</p>
          </div>
        </div>
        <div className="chunking-options">
          {chunkingPresets.map((preset) => (
            <button
              key={preset.id}
              className={settings.chunkingProfile === preset.id ? "active" : ""}
              onClick={() => onSelectChunkingProfile(preset.id)}
            >
              <strong>{preset.name}</strong>
              <span>{preset.description}</span>
            </button>
          ))}
        </div>
        <div className="settings-subsection">
          <div>
            <h4>Relevance Cutoff</h4>
            <p>Hide semantic results below the selected similarity score.</p>
          </div>
          <div className="chunking-options">
            {semanticScoreThresholdPresets.map((preset) => (
              <button
                key={preset.id}
                className={Math.abs(settings.minSemanticScore - preset.value) < 0.001 ? "active" : ""}
                onClick={() => onSelectMinSemanticScore(preset.value)}
              >
                <strong>
                  {preset.name} · {preset.value.toFixed(2)}
                </strong>
                <span>{preset.description}</span>
              </button>
            ))}
          </div>
        </div>
      </section>
    </>
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

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
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
