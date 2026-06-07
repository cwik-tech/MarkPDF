import {
  Check,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns2,
  ArrowDown,
  ArrowUp,
  FilePlus2,
  FileText,
  FolderOpen,
  GripVertical,
  Highlighter,
  Image as ImageIcon,
  MessageSquarePlus,
  Maximize2,
  Minus,
  Minimize2,
  Moon,
  MousePointer2,
  PanelLeft,
  PenLine,
  Plus,
  Printer,
  RotateCw,
  Save,
  ScanText,
  Search,
  Settings as SettingsIcon,
  Signature,
  ScrollText,
  StretchHorizontal,
  StretchVertical,
  Sun,
  Trash2,
  Type,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  deletePdfPage,
  detectFormFields,
  extractEditableOverlays,
  extractOutline,
  createPdfFromImages,
  exportPdfBytes,
  findTextMatches,
  insertBlankPageAfter,
  isPasswordError,
  loadPdfDocument,
  movePdfPage,
  movePdfPageTo
} from "./pdf/document";
import { detectOcrNeed, runDocumentOcr } from "./pdf/ocr";
import { convertDocumentToMarkdown } from "./documentConversion/markdown";
import type { MarkdownConversionProgress } from "./documentConversion/types";
import type {
  FitMode,
  FormFieldState,
  ImagePdfSource,
  DocumentTab,
  MarkdownSearchMatch,
  MarkdownTab,
  OcrPageText,
  OverlayItem,
  PdfTab,
  SearchMatch,
  TabHistoryState,
  ThemeMode,
  ToolMode,
  ViewMode
} from "./types";
import { AISettingsDialog } from "./AISettings";
import { MarkdownPreview } from "./markdown/MarkdownPreview";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./components/resizable";
import type { MarkdownExportSettings, SemanticSearchSettings } from "./global";
import { downloadSemanticModel, indexSemanticDocument, searchSemanticDocument } from "./semanticIndex";
import {
  curatedEmbeddingModels,
  defaultSemanticScoreThreshold,
  legacyRecommendedEmbeddingModelId,
  recommendedEmbeddingModelId
} from "./semanticModels";

const defaultTextColor = "#1f2937";
const supportedImageExtensions = new Set(["gif", "jpeg", "jpg", "png", "webp"]);
const signatureStorageKey = "markpdf-signatures";
const legacySignatureStorageKey = "open-pdf-reader-signatures";
const themeStorageKey = "markpdf-theme";
const legacyThemeStorageKey = "open-pdf-reader-theme";

type SignatureAssetKind = "typed-signature" | "typed-initials" | "date" | "drawn" | "image";
type ToolbarMenu = "fit" | "view" | "recent" | "save";
type SidebarMode = "pages" | "outline" | "comments" | "forms" | "signature" | "semantic";

const defaultSemanticSettings: SemanticSearchSettings = {
  enabled: true,
  activeModelId: recommendedEmbeddingModelId,
  chunkingProfile: "balanced",
  minSemanticScore: defaultSemanticScoreThreshold,
  downloadedModelIds: []
};

const defaultMarkdownSettings: MarkdownExportSettings = {
  defaultEngine: "docling-managed",
  exportMode: "readable",
  includePageMarkers: true,
  useOcrFallback: true,
  includeAnnotations: true,
  aiCleanup: false
};

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

interface SignatureAsset {
  id: string;
  kind: SignatureAssetKind;
  label: string;
  dataUrl: string;
  width: number;
  height: number;
  createdAt: string;
  sourceText?: string;
  fontFamily?: string;
}

interface OperationProgress {
  title: string;
  message: string;
  current?: number;
  total?: number;
}

const signatureFonts = [
  { name: "Classic", family: '"Snell Roundhand", "Brush Script MT", cursive' },
  { name: "Script", family: '"Savoye LET", "Snell Roundhand", cursive' },
  { name: "Flourish", family: '"Zapfino", "Snell Roundhand", cursive' },
  { name: "Ink", family: '"SignPainter", "Brush Script MT", cursive' },
  { name: "Handwritten", family: '"Apple Chancery", "Bradley Hand", cursive' }
];

function newId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function extensionFromName(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function isPdfPath(path: string) {
  return extensionFromName(path) === "pdf";
}

function isMarkdownPath(path: string) {
  const extension = extensionFromName(path);
  return extension === "md" || extension === "markdown";
}

function isImagePath(path: string) {
  return supportedImageExtensions.has(extensionFromName(path));
}

function isPdfTab(tab: DocumentTab | null | undefined): tab is PdfTab {
  return tab?.kind === "pdf";
}

function isMarkdownTab(tab: DocumentTab | null | undefined): tab is MarkdownTab {
  return tab?.kind === "markdown";
}

function findMarkdownMatches(markdown: string, query: string): MarkdownSearchMatch[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];

  const lowerMarkdown = markdown.toLocaleLowerCase();
  const lowerQuery = normalizedQuery.toLocaleLowerCase();
  const matches: MarkdownSearchMatch[] = [];
  let cursor = 0;

  for (;;) {
    const index = lowerMarkdown.indexOf(lowerQuery, cursor);
    if (index === -1) break;
    const snippetStart = Math.max(0, index - 56);
    const snippetEnd = Math.min(markdown.length, index + normalizedQuery.length + 56);
    const prefix = snippetStart > 0 ? "..." : "";
    const suffix = snippetEnd < markdown.length ? "..." : "";
    matches.push({
      id: `markdown-match-${index}`,
      index,
      length: normalizedQuery.length,
      snippet: `${prefix}${markdown.slice(snippetStart, snippetEnd).replace(/\s+/g, " ").trim()}${suffix}`
    });
    cursor = index + normalizedQuery.length;
  }

  return matches;
}

function mimeTypeFromImageName(name: string) {
  const extension = extensionFromName(name);
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return "application/octet-stream";
}

function waitForUiPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function loadSavedSignatureAssets() {
  try {
    const stored = localStorage.getItem(signatureStorageKey) ?? localStorage.getItem(legacySignatureStorageKey);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (asset): asset is SignatureAsset =>
        typeof asset?.id === "string" &&
        typeof asset?.label === "string" &&
        typeof asset?.dataUrl === "string" &&
        typeof asset?.width === "number" &&
        typeof asset?.height === "number"
    );
  } catch {
    return [];
  }
}

function initialsFromName(value: string) {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .map((part) => part[0]?.toLocaleUpperCase() ?? "")
    .join("");
}

function todaySignatureDate() {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function appendSignedSuffix(pathOrName: string) {
  return pathOrName.replace(/(\.pdf)?$/i, " - signed.pdf");
}

function signedDefaultPath(tab: PdfTab) {
  return appendSignedSuffix(tab.path ?? tab.name);
}

function renderSignatureText(text: string, fontFamily: string, fontSize: number, padding = 18) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return null;
  const dpr = Math.max(2, window.devicePixelRatio || 1);
  context.font = `${fontSize}px ${fontFamily}`;
  const measured = context.measureText(text);
  const cssWidth = Math.max(96, Math.ceil(measured.width + padding * 2));
  const cssHeight = Math.max(42, Math.ceil(fontSize * 1.55 + padding));
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  context.scale(dpr, dpr);
  context.clearRect(0, 0, cssWidth, cssHeight);
  context.fillStyle = "#111827";
  context.font = `${fontSize}px ${fontFamily}`;
  context.textBaseline = "middle";
  context.fillText(text, padding, cssHeight / 2);
  return {
    dataUrl: canvas.toDataURL("image/png"),
    width: cssWidth,
    height: cssHeight
  };
}

function createTypedSignatureAssets(name: string, fontFamily: string) {
  const cleanedName = name.trim() || "Signature";
  const initials = initialsFromName(cleanedName) || cleanedName.slice(0, 2).toLocaleUpperCase();
  const dateText = todaySignatureDate();
  const createdAt = new Date().toISOString();
  const signatureImage = renderSignatureText(cleanedName, fontFamily, 42, 20);
  const initialsImage = renderSignatureText(initials, fontFamily, 42, 20);
  const dateImage = renderSignatureText(dateText, '"Inter", "Helvetica Neue", Arial, sans-serif', 21, 12);
  const assets: SignatureAsset[] = [];

  if (signatureImage) {
    assets.push({
      id: newId("signature-typed"),
      kind: "typed-signature",
      label: cleanedName,
      sourceText: cleanedName,
      fontFamily,
      createdAt,
      ...signatureImage
    });
  }

  if (initialsImage) {
    assets.push({
      id: newId("signature-initials"),
      kind: "typed-initials",
      label: `${initials} initials`,
      sourceText: initials,
      fontFamily,
      createdAt,
      ...initialsImage
    });
  }

  if (dateImage) {
    assets.push({
      id: newId("signature-date"),
      kind: "date",
      label: dateText,
      sourceText: dateText,
      createdAt,
      ...dateImage
    });
  }

  return assets;
}

function getInitialTheme(): ThemeMode {
  const stored = localStorage.getItem(themeStorageKey) ?? localStorage.getItem(legacyThemeStorageKey);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App() {
  const [tabs, setTabs] = useState<DocumentTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [tool, setTool] = useState<ToolMode>("select");
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState<SidebarMode | null>(null);
  const [signatureText, setSignatureText] = useState("");
  const [signatureFont, setSignatureFont] = useState(signatureFonts[0].family);
  const [savedSignatures, setSavedSignatures] = useState<SignatureAsset[]>(loadSavedSignatureAssets);
  const [selectedSignatureId, setSelectedSignatureId] = useState<string | null>(null);
  const [drawingSignatureOpen, setDrawingSignatureOpen] = useState(false);
  const [signatureSavePrompt, setSignatureSavePrompt] = useState<{
    name: string;
    resolve: (value: "editable" | "flattened" | "cancel") => void;
  } | null>(null);
  const [searchText, setSearchText] = useState("");
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [operationProgress, setOperationProgress] = useState<OperationProgress | null>(null);
  const [openMenu, setOpenMenu] = useState<ToolbarMenu | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [semanticSettings, setSemanticSettings] = useState<SemanticSearchSettings>(defaultSemanticSettings);
  const [semanticModelDownloadProgress, setSemanticModelDownloadProgress] = useState<PdfTab["semanticIndexProgress"] | null>(null);
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [selectionAction, setSelectionAction] = useState<{
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
    screenX: number;
    screenY: number;
    text: string;
  } | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const menuCloseTimerRef = useRef<number | null>(null);
  const searchCloseTimerRef = useRef<number | null>(null);
  const searchPinnedRef = useRef(false);
  const autoSearchTimerRef = useRef<number | null>(null);
  const searchRequestIdRef = useRef(0);
  const ocrJobsRef = useRef(new Map<string, { cancelled: boolean }>());
  const semanticJobsRef = useRef(new Map<string, { cancelled: boolean }>());
  const semanticStartTimersRef = useRef(new Map<string, number>());
  const tabsRef = useRef<DocumentTab[]>([]);
  const semanticSettingsRef = useRef(semanticSettings);
  const semanticModelDownloadStartedRef = useRef(false);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs]
  );
  const activePdfTab = isPdfTab(activeTab) ? activeTab : null;
  const activeMarkdownText = isMarkdownTab(activeTab) ? activeTab.markdown : null;
  const selectedSignature = useMemo(
    () => savedSignatures.find((asset) => asset.id === selectedSignatureId) ?? savedSignatures[0] ?? null,
    [savedSignatures, selectedSignatureId]
  );

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    semanticSettingsRef.current = semanticSettings;
  }, [semanticSettings]);

  useEffect(() => {
    if ((!activeTab || !activePdfTab) && sidebar !== null) {
      setSidebar(null);
    }
  }, [activeTab, activePdfTab, sidebar]);

  useEffect(() => {
    localStorage.setItem(signatureStorageKey, JSON.stringify(savedSignatures));
    if (!savedSignatures.length) {
      setSelectedSignatureId(null);
      return;
    }
    if (!selectedSignatureId || !savedSignatures.some((asset) => asset.id === selectedSignatureId)) {
      setSelectedSignatureId(savedSignatures[0].id);
    }
  }, [savedSignatures, selectedSignatureId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  useEffect(() => {
    return () => {
      if (menuCloseTimerRef.current !== null) window.clearTimeout(menuCloseTimerRef.current);
      if (searchCloseTimerRef.current !== null) window.clearTimeout(searchCloseTimerRef.current);
      if (autoSearchTimerRef.current !== null) window.clearTimeout(autoSearchTimerRef.current);
      for (const timer of semanticStartTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      semanticStartTimersRef.current.clear();
    };
  }, []);

  const openToolbarMenu = (menu: ToolbarMenu | null) => {
    if (menuCloseTimerRef.current !== null) {
      window.clearTimeout(menuCloseTimerRef.current);
      menuCloseTimerRef.current = null;
    }
    setOpenMenu(menu);
  };

  const scheduleToolbarMenuClose = () => {
    if (menuCloseTimerRef.current !== null) window.clearTimeout(menuCloseTimerRef.current);
    menuCloseTimerRef.current = window.setTimeout(() => {
      setOpenMenu(null);
      menuCloseTimerRef.current = null;
    }, 500);
  };

  const clearSearchCloseTimer = () => {
    if (searchCloseTimerRef.current !== null) {
      window.clearTimeout(searchCloseTimerRef.current);
      searchCloseTimerRef.current = null;
    }
  };

  const scheduleSearchClose = () => {
    clearSearchCloseTimer();
    if (searchText || searchPinnedRef.current) return;
    searchCloseTimerRef.current = window.setTimeout(() => {
      searchInputRef.current?.blur();
      setSearchExpanded(false);
      searchCloseTimerRef.current = null;
    }, 2000);
  };

  const updatePdfTab = useCallback((tabId: string, patch: Partial<PdfTab> | ((tab: PdfTab) => Partial<PdfTab>)) => {
    setTabs((current) =>
      current.map((tab) => {
        if (tab.id !== tabId || !isPdfTab(tab)) return tab;
        const nextPatch = typeof patch === "function" ? patch(tab) : patch;
        return { ...tab, ...nextPatch };
      })
    );
  }, []);

  const updateMarkdownTab = useCallback((tabId: string, patch: Partial<MarkdownTab> | ((tab: MarkdownTab) => Partial<MarkdownTab>)) => {
    setTabs((current) =>
      current.map((tab) => {
        if (tab.id !== tabId || !isMarkdownTab(tab)) return tab;
        const nextPatch = typeof patch === "function" ? patch(tab) : patch;
        return { ...tab, ...nextPatch };
      })
    );
  }, []);

  const clearTabSearch = useCallback(
    (tab: DocumentTab) => {
      if (isPdfTab(tab)) {
        updatePdfTab(tab.id, {
          searchQuery: "",
          searchMatches: [],
          activeSearchMatch: -1,
          semanticResults: [],
          semanticHighlight: null
        });
        return;
      }

      updateMarkdownTab(tab.id, {
        searchQuery: "",
        searchMatches: [],
        activeSearchMatch: -1
      });
    },
    [updateMarkdownTab, updatePdfTab]
  );

  const applySemanticSettings = useCallback((nextSettings: SemanticSearchSettings) => {
    const normalizedSettings = normalizeSemanticSettings(nextSettings);
    setSemanticSettings((previous) => {
      const requiresReindex =
        previous.activeModelId !== normalizedSettings.activeModelId ||
        previous.chunkingProfile !== normalizedSettings.chunkingProfile ||
        previous.enabled !== normalizedSettings.enabled;

      if (requiresReindex) {
        for (const job of semanticJobsRef.current.values()) {
          job.cancelled = true;
        }
        semanticJobsRef.current.clear();
        for (const timer of semanticStartTimersRef.current.values()) {
          window.clearTimeout(timer);
        }
        semanticStartTimersRef.current.clear();
        setTabs((current) =>
          current.map((tab) =>
            isPdfTab(tab)
              ? {
                  ...tab,
                  semanticResults: [],
                  semanticHighlight: null,
                  semanticIndexStatus: normalizedSettings.enabled ? "idle" : "ready",
                  semanticIndexProgress: { status: normalizedSettings.enabled ? "idle" : "ready" },
                  semanticIndexError: undefined
                }
              : tab
          )
        );
      }

      return normalizedSettings;
    });
  }, []);

  const resetSemanticTabs = useCallback(() => {
    for (const job of semanticJobsRef.current.values()) {
      job.cancelled = true;
    }
    semanticJobsRef.current.clear();
    for (const timer of semanticStartTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    semanticStartTimersRef.current.clear();
    setTabs((current) =>
      current.map((tab) =>
        isPdfTab(tab)
          ? {
              ...tab,
              semanticResults: [],
              semanticHighlight: null,
              semanticIndexStatus: semanticSettingsRef.current.enabled ? "idle" : "ready",
              semanticIndexProgress: { status: semanticSettingsRef.current.enabled ? "idle" : "ready" },
              semanticIndexError: undefined
            }
          : tab
      )
    );
  }, []);

  const startSemanticIndex = useCallback(
    async (tabId: string) => {
      if (semanticJobsRef.current.has(tabId)) return;
      const settings = semanticSettingsRef.current;
      if (!settings.enabled || !window.pdfReader?.semantic) return;
      const tab = tabsRef.current.find((item) => item.id === tabId);
      if (!isPdfTab(tab)) return;

      const job = { cancelled: false };
      semanticJobsRef.current.set(tabId, job);
      updatePdfTab(tabId, {
        semanticIndexStatus: "checking",
        semanticIndexProgress: { status: "checking", message: "Checking semantic index" },
        semanticIndexError: undefined
      });

      try {
        await indexSemanticDocument({
          name: tab.name,
          path: tab.path,
          bytes: tab.bytes,
          pdfDoc: tab.pdfDoc,
          ocrPages: tab.ocrPages,
          settings,
          isCancelled: () => job.cancelled,
          onProgress: (progress) => {
            if (job.cancelled) return;
            updatePdfTab(tabId, {
              semanticIndexStatus: progress.status,
              semanticIndexProgress: progress,
              semanticIndexError: undefined
            });
          }
        });

        if (!job.cancelled) {
          updatePdfTab(tabId, {
            semanticIndexStatus: "ready",
            semanticIndexProgress: { status: "ready", message: "Semantic index ready" }
          });
        }
      } catch (error) {
        if (!job.cancelled) {
          updatePdfTab(tabId, {
            semanticIndexStatus: "error",
            semanticIndexError: error instanceof Error ? error.message : "Semantic indexing failed.",
            semanticIndexProgress: { status: "error", message: "Semantic indexing failed" }
          });
        }
      } finally {
        semanticJobsRef.current.delete(tabId);
      }
    },
    [updatePdfTab]
  );

  const showOperationProgress = useCallback(async (progress: OperationProgress) => {
    setOperationProgress(progress);
    await waitForUiPaint();
  }, []);

  const hideOperationProgress = useCallback(async (startedAt: number) => {
    const remaining = Math.max(0, 1000 - (Date.now() - startedAt));
    if (remaining > 0) {
      await delay(remaining);
    }
    setOperationProgress(null);
  }, []);

  const startAutoOcr = useCallback(
    async (tabId: string, pdfDoc: Awaited<ReturnType<typeof loadPdfDocument>>) => {
      if (ocrJobsRef.current.has(tabId)) return;

      const job = { cancelled: false };
      ocrJobsRef.current.set(tabId, job);
      updatePdfTab(tabId, {
        ocrStatus: "checking",
        ocrProgress: { status: "checking", message: "Checking text layer" },
        ocrError: undefined
      });

      try {
        const density = await detectOcrNeed(pdfDoc);
        if (job.cancelled) return;

        if (!density.shouldRunOcr) {
          updatePdfTab(tabId, {
            ocrStatus: "skipped",
            ocrProgress: {
              status: "skipped",
              message: "PDF text layer detected"
            }
          });
          return;
        }

        updatePdfTab(tabId, {
          ocrStatus: "running",
          ocrProgress: {
            status: "running",
            page: 1,
            totalPages: pdfDoc.numPages,
            progress: 0,
            message: "Starting OCR"
          }
        });

        const ocrPages = await runDocumentOcr(pdfDoc, {
          isCancelled: () => job.cancelled,
          onProgress: (progress) => {
            if (!job.cancelled) {
              updatePdfTab(tabId, (tab) => ({
                ocrProgress: {
                  ...tab.ocrProgress,
                  ...progress
                }
              }));
            }
          }
        });

        if (job.cancelled) return;
        updatePdfTab(tabId, {
          ocrStatus: "ready",
          ocrPages,
          ocrProgress: {
            status: "ready",
            page: pdfDoc.numPages,
            totalPages: pdfDoc.numPages,
            progress: 1,
            message: "OCR ready"
          }
        });
      } catch (error) {
        if (!job.cancelled) {
          updatePdfTab(tabId, {
            ocrStatus: "error",
            ocrError: error instanceof Error ? error.message : "OCR failed.",
            ocrProgress: {
              status: "error",
              message: "OCR failed"
            }
          });
        }
      } finally {
        ocrJobsRef.current.delete(tabId);
      }
    },
    [updatePdfTab]
  );

  const addTabFromBytes = useCallback(
    async (
      bytes: Uint8Array,
      name: string,
      path?: string,
      options: { autoOcr?: boolean; dirty?: boolean } = {}
    ) => {
      let password: string | undefined;
      let pdfDoc!: Awaited<ReturnType<typeof loadPdfDocument>>;

      for (;;) {
        try {
          pdfDoc = await loadPdfDocument(bytes, password);
          break;
        } catch (error) {
          if (!isPasswordError(error)) {
            throw error;
          }

          const nextPassword = window.prompt(`Password required for "${name}"`);
          if (nextPassword === null) return;
          password = nextPassword;
        }
      }

      const formFields = await detectFormFields(bytes);
      const outline = await extractOutline(pdfDoc);
      const overlays = await extractEditableOverlays(bytes);
      const tab: PdfTab = {
        kind: "pdf",
        id: newId("tab"),
        name,
        path,
        bytes,
        pdfDoc,
        pageCount: pdfDoc.numPages,
        currentPage: 1,
        zoom: 1,
        rotation: 0,
        viewMode: "single",
        fitMode: "actual",
        scrolling: false,
        overlays,
        formFields,
        outline,
        searchQuery: "",
        searchMatches: [],
        activeSearchMatch: -1,
        semanticResults: [],
        semanticHighlight: null,
        semanticIndexStatus: "idle",
        semanticIndexProgress: { status: "idle" },
        ocrPages: [],
        ocrStatus: options.autoOcr === false ? undefined : "checking",
        ocrProgress: options.autoOcr === false ? undefined : { status: "checking", message: "Checking text layer" },
        undoStack: [],
        redoStack: [],
        dirty: options.dirty ?? false
      };

      setTabs((current) => [...current, tab]);
      setActiveTabId(tab.id);
      if (options.autoOcr !== false) {
        void startAutoOcr(tab.id, pdfDoc);
      }
    },
    [startAutoOcr]
  );

  const addMarkdownTab = useCallback((markdown: string, name: string, path?: string) => {
    const tab: MarkdownTab = {
      kind: "markdown",
      id: newId("tab"),
      name,
      path,
      markdown,
      searchQuery: "",
      searchMatches: [],
      activeSearchMatch: -1,
      dirty: false
    };
    setTabs((current) => [...current, tab]);
    setActiveTabId(tab.id);
    setSidebar(null);
    setTool("select");
    setSelectedOverlayId(null);
    setSelectionAction(null);
  }, []);

  const addImagePdfTab = useCallback(
    async (images: ImagePdfSource[]) => {
      if (images.length === 0) return;
      await showOperationProgress({
        title: "Please wait, loading images",
        message: "Creating PDF pages",
        current: 0,
        total: images.length
      });
      const bytes = await createPdfFromImages(images, async (progress) => {
        await showOperationProgress({
          title: "Please wait, loading images",
          message: `Creating PDF page ${progress.current} of ${progress.total}`,
          current: progress.current,
          total: progress.total
        });
      });
      await showOperationProgress({
        title: "Please wait, loading images",
        message: "Opening generated PDF",
        current: images.length,
        total: images.length
      });
      const name = images.length === 1 ? `${images[0].name.replace(/\.[^.]+$/, "") || "Image"}.pdf` : "Images.pdf";
      await addTabFromBytes(Uint8Array.from(bytes), name, undefined, { autoOcr: false, dirty: true });
      setSidebar("pages");
    },
    [addTabFromBytes, showOperationProgress]
  );

  const openFilePaths = useCallback(
    async (paths: string[]) => {
      if (!window.pdfReader) return;
      const pdfPaths = paths.filter(isPdfPath);
      const markdownPaths = paths.filter(isMarkdownPath);
      const imagePaths = paths.filter(isImagePath);
      const unsupportedPaths = paths.filter((path) => !isPdfPath(path) && !isMarkdownPath(path) && !isImagePath(path));

      if (unsupportedPaths.length > 0) {
        window.alert(`Unsupported file type: ${unsupportedPaths.map(fileNameFromPath).join(", ")}`);
      }

      for (const path of pdfPaths) {
        try {
          const result = await window.pdfReader.readPdf(path);
          await addTabFromBytes(Uint8Array.from(result.bytes), result.name, result.path);
        } catch (error) {
          window.alert(error instanceof Error ? error.message : `Could not open "${path}".`);
        }
      }

      for (const path of markdownPaths) {
        try {
          const result = await window.pdfReader.readMarkdown(path);
          addMarkdownTab(result.markdown, result.name, result.path);
        } catch (error) {
          window.alert(error instanceof Error ? error.message : `Could not open "${path}".`);
        }
      }

      if (imagePaths.length > 0) {
        const progressStartedAt = Date.now();
        const images: ImagePdfSource[] = [];

        try {
          for (const [index, path] of imagePaths.entries()) {
            await showOperationProgress({
              title: "Please wait, loading images",
              message: `Loading image ${index + 1} of ${imagePaths.length}`,
              current: index,
              total: imagePaths.length
            });

            try {
              const result = await window.pdfReader.readImage(path);
              images.push({
                id: newId("image"),
                name: result.name,
                path: result.path,
                mimeType: result.mimeType,
                bytes: Uint8Array.from(result.bytes)
              });
            } catch (error) {
              window.alert(error instanceof Error ? error.message : `Could not open "${path}".`);
            }
          }

          try {
            await addImagePdfTab(images);
          } catch (error) {
            window.alert(error instanceof Error ? error.message : "Could not create PDF from images.");
          }
        } finally {
          await hideOperationProgress(progressStartedAt);
        }
      }

      setRecentFiles(await window.pdfReader.listRecentFiles());
    },
    [addImagePdfTab, addMarkdownTab, addTabFromBytes, hideOperationProgress, showOperationProgress]
  );

  const loadRecentFiles = useCallback(async () => {
    if (!window.pdfReader) return;
    setRecentFiles(await window.pdfReader.listRecentFiles());
  }, []);

  const removeRecentFile = useCallback(async (path: string) => {
    if (!window.pdfReader) {
      setRecentFiles((current) => current.filter((item) => item !== path));
      return;
    }

    setRecentFiles(await window.pdfReader.removeRecentFile(path));
  }, []);

  useEffect(() => {
    void loadRecentFiles();
  }, [loadRecentFiles]);

  useEffect(() => {
    if (!window.pdfReader?.semantic) return;
    void window.pdfReader.semantic.getSettings().then(async (settings) => {
      const normalizedSettings = normalizeSemanticSettings(settings);
      applySemanticSettings(normalizedSettings);
      if (
        normalizedSettings.activeModelId !== settings.activeModelId ||
        normalizedSettings.minSemanticScore !== settings.minSemanticScore ||
        normalizedSettings.downloadedModelIds.length !== settings.downloadedModelIds.length
      ) {
        await window.pdfReader?.semantic.saveSettings(normalizedSettings);
      }
    });
  }, [applySemanticSettings]);

  useEffect(() => {
    if (!window.pdfReader?.markdown) return;
    let cancelled = false;

    void window.pdfReader.markdown.listEngines().then(async (engines) => {
      if (cancelled) return;
      const doclingEngine = engines.find((engine) => engine.id === "docling-managed");
      if (doclingEngine?.available) return;

      const progressStartedAt = Date.now();
      try {
        await showOperationProgress({
          title: "Preparing Markdown Export",
          message: "Preparing Markdown converter",
          current: 0,
          total: 4
        });
        const cleanup = window.pdfReader?.onMarkdownInstallProgress?.((progress) => {
          void showOperationProgress({
            title: "Preparing Markdown Export",
            message: progress.message,
            current: progress.current,
            total: progress.total
          });
        });
        try {
          await window.pdfReader?.markdown.installDocling();
        } finally {
          cleanup?.();
        }
      } catch (error) {
        await showOperationProgress({
          title: "Preparing Markdown Export",
          message: error instanceof Error ? error.message : "Markdown converter setup failed.",
          current: 0,
          total: 4
        });
      } finally {
        await hideOperationProgress(progressStartedAt);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [hideOperationProgress, showOperationProgress]);

  useEffect(() => {
    if (!window.pdfReader?.semantic || !semanticSettings.enabled) return;
    if (semanticSettings.downloadedModelIds.includes(recommendedEmbeddingModelId)) return;
    if (semanticModelDownloadStartedRef.current) return;

    semanticModelDownloadStartedRef.current = true;
    setSemanticModelDownloadProgress({
      status: "downloading",
      message: "Downloading model"
    });

    void downloadSemanticModel(recommendedEmbeddingModelId, (progress) => {
      setSemanticModelDownloadProgress(progress);
    })
      .then((settings) => {
        if (settings) applySemanticSettings(settings);
        setSemanticModelDownloadProgress({
          status: "ready",
          message: "Model ready"
        });
        window.setTimeout(() => setSemanticModelDownloadProgress(null), 1800);
      })
      .catch((error) => {
        console.warn("Recommended semantic model download failed", error);
        setSemanticModelDownloadProgress(null);
        semanticModelDownloadStartedRef.current = false;
      });
  }, [applySemanticSettings, semanticSettings.downloadedModelIds, semanticSettings.enabled]);

  useEffect(() => {
    if (!semanticSettings.enabled) return;

    for (const tab of tabs) {
      if (!isPdfTab(tab)) continue;
      const ocrSettled =
        tab.ocrStatus === "skipped" ||
        tab.ocrStatus === "ready" ||
        tab.ocrStatus === "error" ||
        typeof tab.ocrStatus === "undefined";
      const semanticSettled =
        semanticStartTimersRef.current.has(tab.id) ||
        tab.semanticIndexStatus === "checking" ||
        tab.semanticIndexStatus === "downloading" ||
        tab.semanticIndexStatus === "indexing" ||
        tab.semanticIndexStatus === "ready" ||
        tab.semanticIndexStatus === "error";

      if (ocrSettled && !semanticSettled) {
        const timer = window.setTimeout(() => {
          semanticStartTimersRef.current.delete(tab.id);
          void startSemanticIndex(tab.id);
        }, 1200);
        semanticStartTimersRef.current.set(tab.id, timer);
      }
    }
    return () => {
      for (const timer of semanticStartTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      semanticStartTimersRef.current.clear();
    };
  }, [semanticSettings, startSemanticIndex, tabs]);

  useEffect(() => {
    if (!window.pdfReader) return undefined;
    void window.pdfReader.isFullScreen().then(setIsFullScreen);
    return window.pdfReader.onFullScreenChange(setIsFullScreen);
  }, []);

  useEffect(() => {
    if (!window.pdfReader) return undefined;
    const cleanupSingle = window.pdfReader.onOpenFile((filePath) => void openFilePaths([filePath]));
    const cleanupBatch = window.pdfReader.onOpenFiles((filePaths) => void openFilePaths(filePaths));
    void window.pdfReader.readyForOpenFiles();
    return () => {
      cleanupSingle();
      cleanupBatch();
    };
  }, [openFilePaths]);

  const openFromDialog = async () => {
    if (!window.pdfReader) {
      window.alert("Desktop file dialogs are available in Electron. Drop a PDF here for browser preview.");
      return;
    }
    const paths = await window.pdfReader.openPdfDialog();
    if (paths.length > 0) {
      await openFilePaths(paths);
    }
  };

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    const pdfFiles = files.filter(
      (file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
    );
    const markdownFiles = files.filter((file) => file.type === "text/markdown" || isMarkdownPath(file.name));
    const imageFiles = files.filter((file) => file.type.startsWith("image/") || isImagePath(file.name));

    for (const file of pdfFiles) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await addTabFromBytes(bytes, file.name);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : `Could not open "${file.name}".`);
      }
    }

    for (const file of markdownFiles) {
      try {
        addMarkdownTab(await file.text(), file.name);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : `Could not open "${file.name}".`);
      }
    }

    if (imageFiles.length > 0) {
      const progressStartedAt = Date.now();
      try {
        const images: ImagePdfSource[] = [];

        for (const [index, file] of imageFiles.entries()) {
          await showOperationProgress({
            title: "Please wait, loading images",
            message: `Loading image ${index + 1} of ${imageFiles.length}`,
            current: index,
            total: imageFiles.length
          });
          images.push({
            id: newId("image"),
            name: file.name,
            mimeType: file.type || mimeTypeFromImageName(file.name),
            bytes: new Uint8Array(await file.arrayBuffer())
          });
        }

        await addImagePdfTab(images);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : "Could not create PDF from images.");
      } finally {
        await hideOperationProgress(progressStartedAt);
      }
    }
  };

  const requestUnsavedAction = async (tab: DocumentTab) => {
    if (!tab.dirty) return "discard" as const;
    if (window.pdfReader?.confirmUnsaved) return window.pdfReader.confirmUnsaved(tab.name);
    return window.confirm(`Close "${tab.name}" without saving changes?`) ? "discard" : "cancel";
  };

  const closeTab = async (tabId: string) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;

    const action = await requestUnsavedAction(tab);
    if (action === "cancel") return;
    if (action === "save" && (!isPdfTab(tab) || !(await saveTabWithSignaturePrompt(tab, false, false)))) {
      return;
    }

    setTabs((current) => current.filter((item) => item.id !== tabId));
    const ocrJob = ocrJobsRef.current.get(tabId);
    if (ocrJob) ocrJob.cancelled = true;
    if (activeTabId === tabId) {
      const remaining = tabs.filter((item) => item.id !== tabId);
      setActiveTabId(remaining.at(-1)?.id ?? null);
    }
  };

  const applyFitMode = async (fitMode: FitMode) => {
    if (!activePdfTab || !workspaceRef.current) return;
    const page = await activePdfTab.pdfDoc.getPage(activePdfTab.currentPage);
    const viewport = page.getViewport({ scale: 1, rotation: activePdfTab.rotation });
    const bounds = workspaceRef.current.getBoundingClientRect();
    const availableWidth = Math.max(320, bounds.width - 80);
    const availableHeight = Math.max(320, bounds.height - 80);
    const widthScale = availableWidth / viewport.width;
    const heightScale = availableHeight / viewport.height;
    const zoom =
      fitMode === "actual"
        ? 1
        : fitMode === "width"
          ? widthScale
          : fitMode === "height"
            ? heightScale
            : Math.min(widthScale, heightScale);

    updatePdfTab(activePdfTab.id, { fitMode, zoom: Number(zoom.toFixed(2)) });
  };

  const saveTab = async (
    tabToSave: PdfTab,
    saveAs = false,
    flattenForms = false,
    options: { targetPath?: string; defaultPath?: string } = {}
  ) => {
    let targetPath = options.targetPath ?? tabToSave.path;

    if (window.pdfReader && (!targetPath || saveAs)) {
      const selectedPath = await window.pdfReader.savePdfDialog(options.defaultPath ?? tabToSave.name);
      if (!selectedPath) return false;
      targetPath = selectedPath;
    }

    if (window.pdfReader && !targetPath) return false;

    const progressStartedAt = Date.now();

    try {
      await showOperationProgress({
        title: "Saving PDF",
        message: "Preparing document",
        current: 0,
        total: 3
      });
      const bytes = await exportPdfBytes(tabToSave.bytes, tabToSave.overlays, tabToSave.formFields, flattenForms, {
        bakeOverlays: flattenForms,
        persistEditable: !flattenForms,
        writeStandardAnnotations: !flattenForms
      });

      if (!window.pdfReader) {
        await showOperationProgress({
          title: "Saving PDF",
          message: "Downloading PDF",
          current: 2,
          total: 3
        });
        downloadBytes(bytes, options.defaultPath ?? tabToSave.name);
        return true;
      }

      if (!targetPath) return false;

      await showOperationProgress({
        title: "Saving PDF",
        message: "Writing file",
        current: 1,
        total: 3
      });
      const written = await window.pdfReader.writePdf(targetPath, bytes);
      const nextBytes = Uint8Array.from(bytes);
      await showOperationProgress({
        title: "Saving PDF",
        message: "Refreshing document",
        current: 2,
        total: 3
      });
      const pdfDoc = await loadPdfDocument(nextBytes);
      const formFields = flattenForms ? [] : await detectFormFields(nextBytes);
      const outline = await extractOutline(pdfDoc);
      const overlays = flattenForms ? [] : await extractEditableOverlays(nextBytes);

      updatePdfTab(tabToSave.id, {
        path: written.path,
        name: written.name,
        bytes: nextBytes,
        pdfDoc,
        pageCount: pdfDoc.numPages,
        overlays,
        formFields,
        outline,
        searchMatches: [],
        activeSearchMatch: -1,
        semanticResults: [],
        semanticHighlight: null,
        semanticIndexStatus: "idle",
        semanticIndexProgress: { status: "idle" },
        ocrPages: [],
        ocrStatus: "checking",
        ocrProgress: { status: "checking", message: "Checking text layer" },
        undoStack: [],
        redoStack: [],
        dirty: false
      });
      await showOperationProgress({
        title: "Saving PDF",
        message: "Save complete",
        current: 3,
        total: 3
      });
      void startAutoOcr(tabToSave.id, pdfDoc);
      await loadRecentFiles();
      return true;
    } finally {
      await hideOperationProgress(progressStartedAt);
    }
  };

  const requestSignatureSaveMode = async (tabToSave: PdfTab) => {
    if (!tabToSave.overlays.some((overlay) => overlay.kind === "signature")) return "editable" as const;
    return new Promise<"editable" | "flattened" | "cancel">((resolve) => {
      setSignatureSavePrompt({ name: tabToSave.name, resolve });
    });
  };

  const saveTabWithSignaturePrompt = async (tabToSave: PdfTab, saveAs = false, flattenForms = false) => {
    const signedPath = signedDefaultPath(tabToSave);
    const signedSaveOptions = { targetPath: tabToSave.path ? signedPath : undefined, defaultPath: signedPath };
    if (flattenForms) return saveTab(tabToSave, false, true, signedSaveOptions);
    const mode = await requestSignatureSaveMode(tabToSave);
    if (mode === "cancel") return false;
    if (mode === "flattened") return saveTab(tabToSave, false, true, signedSaveOptions);
    return saveTab(tabToSave, saveAs, false);
  };

  const saveActiveTab = async (saveAs = false, flattenForms = false) => {
    if (!activePdfTab) return false;
    return saveTabWithSignaturePrompt(activePdfTab, saveAs, flattenForms);
  };

  const saveActiveTabAsMarkdown = async () => {
    if (!activePdfTab) return false;
    const defaultPath = activePdfTab.name.replace(/\.[^.]+$/, "") + ".md";
    const targetPath = window.pdfReader ? await window.pdfReader.saveMarkdownDialog(defaultPath) : defaultPath;
    if (!targetPath) return false;

    const progressStartedAt = Date.now();

    try {
      await showOperationProgress({
        title: "Saving Markdown",
        message: "Loading Markdown settings",
        current: 0,
        total: activePdfTab.pageCount + 3
      });

      const savedSettings = (await window.pdfReader?.markdown.getSettings()) ?? defaultMarkdownSettings;
      const settings: MarkdownExportSettings = {
        ...savedSettings,
        defaultEngine: "docling-managed"
      };
      let useBuiltInFallback = false;
      let fallbackWarning: string | null = null;

      if (window.pdfReader?.markdown) {
        try {
          const engines = await window.pdfReader.markdown.listEngines();
          let managedEngine = engines.find((engine) => engine.id === "docling-managed");
          if (!managedEngine?.available) {
            await showOperationProgress({
              title: "Saving Markdown",
              message: "Preparing Markdown converter",
              current: 0,
              total: 4
            });
            const cleanup = window.pdfReader.onMarkdownInstallProgress?.((progress) => {
              void showOperationProgress({
                title: "Saving Markdown",
                message: progress.message,
                current: progress.current,
                total: progress.total
              });
            });
            try {
              await window.pdfReader.markdown.installDocling();
            } finally {
              cleanup?.();
            }

            const nextEngines = await window.pdfReader.markdown.listEngines();
            managedEngine = nextEngines.find((engine) => engine.id === "docling-managed");
          }

          if (!managedEngine?.available) {
            throw new Error(managedEngine?.error ?? "The Markdown converter is not available.");
          }
        } catch {
          useBuiltInFallback = true;
          fallbackWarning = "Advanced Markdown conversion was unavailable; saved with basic text extraction.";
        }
      } else {
        useBuiltInFallback = true;
        fallbackWarning = "Advanced Markdown conversion is available only in the desktop app; saved with basic text extraction.";
      }

      const onProgress = (progress: MarkdownConversionProgress) => {
        void showOperationProgress({
          title: "Saving Markdown",
          message: progress.message,
          current: progress.current,
          total: progress.total ? progress.total + 2 : activePdfTab.pageCount + 3
        });
      };

      const convertWithSettings = (conversionSettings: MarkdownExportSettings) =>
        convertDocumentToMarkdown({
          name: activePdfTab.name,
          bytes: activePdfTab.bytes,
          pdfDoc: activePdfTab.pdfDoc,
          ocrPages: activePdfTab.ocrPages,
          overlays: activePdfTab.overlays,
          settings: conversionSettings,
          onProgress
        });

      let result = await (async () => {
        try {
          return await convertWithSettings({
            ...settings,
            defaultEngine: useBuiltInFallback ? "builtin-text" : "docling-managed"
          });
        } catch (error) {
          if (useBuiltInFallback) throw error;
          fallbackWarning = "Advanced Markdown conversion failed; saved with basic text extraction.";
          return convertWithSettings({
            ...settings,
            defaultEngine: "builtin-text"
          });
        }
      })();

      if (fallbackWarning) {
        result = {
          ...result,
          warnings: [fallbackWarning, ...result.warnings]
        };
      }

      await showOperationProgress({
        title: "Saving Markdown",
        message: "Writing Markdown file",
        current: activePdfTab.pageCount + 2,
        total: activePdfTab.pageCount + 3
      });

      if (window.pdfReader) {
        await window.pdfReader.writeMarkdown(targetPath, result.markdown);
      } else {
        downloadText(result.markdown, defaultPath, "text/markdown");
      }

      await showOperationProgress({
        title: "Saving Markdown",
        message: result.warnings[0] ?? "Markdown saved",
        current: activePdfTab.pageCount + 3,
        total: activePdfTab.pageCount + 3
      });
      return true;
    } catch (error) {
      await showOperationProgress({
        title: "Saving Markdown",
        message: error instanceof Error ? error.message : "Markdown export failed.",
        current: 0,
        total: activePdfTab.pageCount + 3
      });
      return false;
    } finally {
      await hideOperationProgress(progressStartedAt);
    }
  };

  useEffect(() => {
    if (!window.pdfReader) return undefined;

    return window.pdfReader.onWindowRequestClose(async () => {
      for (const tab of tabs.filter((item) => item.dirty)) {
        const action = await requestUnsavedAction(tab);
        if (action === "cancel") return;
        if (action === "save" && (!isPdfTab(tab) || !(await saveTabWithSignaturePrompt(tab, false, false)))) return;
      }

      await window.pdfReader?.closeWindowAfterConfirm();
    });
  }, [tabs]);

  const printActiveTab = async () => {
    if (!activePdfTab) return;
    const bytes = await exportPdfBytes(activePdfTab.bytes, activePdfTab.overlays, activePdfTab.formFields, false, {
      bakeOverlays: true,
      writeStandardAnnotations: false
    });
    const printBuffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(printBuffer).set(bytes);
    const blob = new Blob([printBuffer], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const frame = document.createElement("iframe");
    frame.style.position = "fixed";
    frame.style.right = "0";
    frame.style.bottom = "0";
    frame.style.width = "0";
    frame.style.height = "0";
    frame.src = url;
    document.body.appendChild(frame);
    frame.onload = () => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
      setTimeout(() => {
        URL.revokeObjectURL(url);
        frame.remove();
      }, 2000);
    };
  };

  const toggleFullScreen = async () => {
    const next = !isFullScreen;
    if (!window.pdfReader) {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
        setIsFullScreen(true);
      } else {
        await document.exitFullscreen();
        setIsFullScreen(false);
      }
      return;
    }

    setIsFullScreen(await window.pdfReader.setFullScreen(next));
  };

  const snapshotTab = (tab: PdfTab): TabHistoryState => ({
    bytes: tab.bytes.slice(),
    currentPage: tab.currentPage,
    overlays: structuredClone(tab.overlays),
    formFields: structuredClone(tab.formFields),
    outline: structuredClone(tab.outline)
  });

  const pushHistory = (tab: PdfTab) => ({
    undoStack: [...tab.undoStack, snapshotTab(tab)].slice(-50),
    redoStack: []
  });

  const addOverlay = (page: number, x: number, y: number) => {
    if (!activePdfTab) return;

    let overlay: OverlayItem | null = null;

    if (tool === "text") {
      overlay = {
        id: newId("text"),
        kind: "text",
        page,
        x,
        y,
        width: 180,
        height: 48,
        text: "Text",
        fontSize: 16,
        color: defaultTextColor
      };
    }

    if (tool === "comment") {
      overlay = {
        id: newId("comment"),
        kind: "comment",
        page,
        x,
        y,
        width: 180,
        height: 92,
        text: "Comment",
        fontSize: 12,
        color: "#2f2400"
      };
    }

    if (tool === "highlight") {
      overlay = {
        id: newId("highlight"),
        kind: "highlight",
        page,
        x,
        y,
        width: 180,
        height: 28,
        color: "#facc15"
      };
    }

    if (tool === "signature") {
      if (!selectedSignature) {
        window.alert("Create or select a signature first.");
        setSidebar("signature");
        return;
      }
      const targetWidth = Math.min(260, Math.max(70, selectedSignature.width));
      const targetHeight = Math.max(24, Math.round((selectedSignature.height / selectedSignature.width) * targetWidth));
      overlay = {
        id: newId("signature"),
        kind: "signature",
        page,
        x,
        y,
        width: targetWidth,
        height: targetHeight,
        text: selectedSignature.label,
        fontSize: 28,
        dataUrl: selectedSignature.dataUrl
      };
    }

    if (!overlay) return;

    updatePdfTab(activePdfTab.id, (tab) => ({
      ...pushHistory(tab),
      overlays: [...tab.overlays, overlay],
      dirty: true
    }));
    setSelectedOverlayId(overlay.id);
    setTool("select");
  };

  const updateOverlay = (overlayId: string, patch: Partial<OverlayItem>, recordHistory = true) => {
    if (!activePdfTab) return;
    updatePdfTab(activePdfTab.id, (tab) => ({
      ...(recordHistory ? pushHistory(tab) : {}),
      overlays: tab.overlays.map((overlay) => (overlay.id === overlayId ? { ...overlay, ...patch } : overlay)),
      dirty: true
    }));
  };

  const addSelectionOverlay = (kind: "highlight" | "comment") => {
    if (!activePdfTab || !selectionAction) return;
    const overlay: OverlayItem = {
      id: newId(kind),
      kind,
      page: selectionAction.page,
      x: selectionAction.x,
      y: selectionAction.y,
      width: selectionAction.width,
      height: selectionAction.height,
      text: kind === "comment" ? "" : undefined,
      fontSize: kind === "comment" ? 12 : undefined,
      color: "#facc15",
      minimized: kind === "comment" ? true : undefined
    };

    updatePdfTab(activePdfTab.id, (tab) => ({
      ...pushHistory(tab),
      overlays: [...tab.overlays, overlay],
      dirty: true
    }));
    setSelectedOverlayId(overlay.id);
    setSelectionAction(null);
  };

  const deleteOverlay = (overlayId: string) => {
    if (!activePdfTab) return;
    updatePdfTab(activePdfTab.id, (tab) => ({
      ...pushHistory(tab),
      overlays: tab.overlays.filter((overlay) => overlay.id !== overlayId),
      dirty: true
    }));
    setSelectedOverlayId(null);
  };

  const updateFormField = (fieldName: string, value: string | boolean) => {
    if (!activePdfTab) return;
    updatePdfTab(activePdfTab.id, (tab) => ({
      ...pushHistory(tab),
      formFields: tab.formFields.map((field) => (field.name === fieldName ? { ...field, value } : field)),
      dirty: true
    }));
  };

  const restoreHistoryState = async (tabId: string, state: TabHistoryState) => {
    const pdfDoc = await loadPdfDocument(state.bytes);
    updatePdfTab(tabId, {
      bytes: state.bytes,
      pdfDoc,
      pageCount: pdfDoc.numPages,
      currentPage: Math.min(state.currentPage, pdfDoc.numPages),
      overlays: state.overlays,
      formFields: state.formFields,
      outline: state.outline,
      searchMatches: [],
      activeSearchMatch: -1,
      semanticResults: [],
      semanticHighlight: null,
      semanticIndexStatus: "idle",
      semanticIndexProgress: { status: "idle" },
      ocrPages: [],
      ocrStatus: "checking",
      ocrProgress: { status: "checking", message: "Checking text layer" },
      dirty: true
    });
    void startAutoOcr(tabId, pdfDoc);
  };

  const undoActiveTab = async () => {
    if (!activePdfTab || activePdfTab.undoStack.length === 0) return;
    const previous = activePdfTab.undoStack.at(-1);
    if (!previous) return;
    const redoState = snapshotTab(activePdfTab);
    updatePdfTab(activePdfTab.id, {
      undoStack: activePdfTab.undoStack.slice(0, -1),
      redoStack: [...activePdfTab.redoStack, redoState].slice(-50)
    });
    await restoreHistoryState(activePdfTab.id, previous);
  };

  const redoActiveTab = async () => {
    if (!activePdfTab || activePdfTab.redoStack.length === 0) return;
    const next = activePdfTab.redoStack.at(-1);
    if (!next) return;
    const undoState = snapshotTab(activePdfTab);
    updatePdfTab(activePdfTab.id, {
      undoStack: [...activePdfTab.undoStack, undoState].slice(-50),
      redoStack: activePdfTab.redoStack.slice(0, -1)
    });
    await restoreHistoryState(activePdfTab.id, next);
  };

  const replaceDocumentBytes = async (
    bytes: Uint8Array,
    page: number,
    updateOverlays: (overlays: OverlayItem[]) => OverlayItem[]
  ) => {
    if (!activePdfTab) return;
    const pdfDoc = await loadPdfDocument(bytes);
    const formFields = await detectFormFields(bytes);
    const outline = await extractOutline(pdfDoc);
    updatePdfTab(activePdfTab.id, (tab) => ({
      ...pushHistory(tab),
      bytes,
      pdfDoc,
      pageCount: pdfDoc.numPages,
      currentPage: Math.min(Math.max(1, page), pdfDoc.numPages),
      overlays: updateOverlays(tab.overlays),
      formFields,
      outline,
      searchMatches: [],
      activeSearchMatch: -1,
      semanticResults: [],
      semanticHighlight: null,
      semanticIndexStatus: "idle",
      semanticIndexProgress: { status: "idle" },
      ocrPages: [],
      ocrStatus: "checking",
      ocrProgress: { status: "checking", message: "Checking text layer" },
      dirty: true
    }));
    void startAutoOcr(activePdfTab.id, pdfDoc);
  };

  const insertPageAfterCurrent = async () => {
    if (!activePdfTab) return;
    const bytes = await insertBlankPageAfter(activePdfTab.bytes, activePdfTab.currentPage);
    await replaceDocumentBytes(bytes, activePdfTab.currentPage + 1, (overlays) =>
      overlays.map((overlay) => (overlay.page > activePdfTab.currentPage ? { ...overlay, page: overlay.page + 1 } : overlay))
    );
  };

  const deleteCurrentPage = async () => {
    if (!activePdfTab || activePdfTab.pageCount <= 1) return;
    if (!window.confirm(`Delete page ${activePdfTab.currentPage}?`)) return;
    const deletedPage = activePdfTab.currentPage;
    const bytes = await deletePdfPage(activePdfTab.bytes, deletedPage);
    await replaceDocumentBytes(bytes, Math.min(deletedPage, activePdfTab.pageCount - 1), (overlays) =>
      overlays
        .filter((overlay) => overlay.page !== deletedPage)
        .map((overlay) => (overlay.page > deletedPage ? { ...overlay, page: overlay.page - 1 } : overlay))
    );
  };

  const moveCurrentPage = async (direction: -1 | 1) => {
    if (!activePdfTab) return;
    const fromPage = activePdfTab.currentPage;
    const toPage = fromPage + direction;
    if (toPage < 1 || toPage > activePdfTab.pageCount) return;
    const bytes = await movePdfPage(activePdfTab.bytes, fromPage, direction);
    await replaceDocumentBytes(bytes, toPage, (overlays) =>
      overlays.map((overlay) => {
        if (overlay.page === fromPage) return { ...overlay, page: toPage };
        if (direction === -1 && overlay.page === toPage) return { ...overlay, page: fromPage };
        if (direction === 1 && overlay.page === toPage) return { ...overlay, page: fromPage };
        return overlay;
      })
    );
  };

  const movePageTo = async (fromPage: number, toPage: number) => {
    if (!activePdfTab || fromPage === toPage) return;
    if (fromPage < 1 || fromPage > activePdfTab.pageCount || toPage < 1 || toPage > activePdfTab.pageCount) return;

    const bytes = await movePdfPageTo(activePdfTab.bytes, fromPage, toPage);
    await replaceDocumentBytes(bytes, toPage, (overlays) =>
      overlays.map((overlay) => {
        if (overlay.page === fromPage) return { ...overlay, page: toPage };
        if (fromPage < toPage && overlay.page > fromPage && overlay.page <= toPage) {
          return { ...overlay, page: overlay.page - 1 };
        }
        if (fromPage > toPage && overlay.page >= toPage && overlay.page < fromPage) {
          return { ...overlay, page: overlay.page + 1 };
        }
        return overlay;
      })
    );
  };

  const applySearch = useCallback(async (tab: DocumentTab, query: string, navigateToFirstMatch = true, activateSemantic = false) => {
    const normalizedQuery = query.trim();
    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;

    if (!normalizedQuery) {
      clearTabSearch(tab);
      setSidebar((current) => (current === "semantic" ? null : current));
      return;
    }

    if (isMarkdownTab(tab)) {
      const matches = findMarkdownMatches(tab.markdown, normalizedQuery);
      updateMarkdownTab(tab.id, {
        searchQuery: normalizedQuery,
        searchMatches: matches,
        activeSearchMatch: matches.length ? 0 : -1
      });
      setSidebar((current) => (current === "semantic" ? null : current));
      return;
    }

    if (activateSemantic && semanticSettingsRef.current.enabled) {
      setSidebar("semantic");
    }

    const matches = await findTextMatches(tab.pdfDoc, normalizedQuery, tab.ocrPages);
    if (requestId !== searchRequestIdRef.current) return;

    const firstMatch = matches[0];
    updatePdfTab(tab.id, (currentTab) => ({
      searchQuery: normalizedQuery,
      searchMatches: matches,
      activeSearchMatch: firstMatch ? 0 : -1,
      currentPage: navigateToFirstMatch && firstMatch ? firstMatch.page : currentTab.currentPage,
      semanticHighlight: null
    }));

    const currentTab = tabsRef.current.find((item) => item.id === tab.id) ?? tab;
    if (!isPdfTab(currentTab)) return;
    if (!activateSemantic) {
      return;
    }

    if (currentTab.semanticIndexStatus !== "ready" || !semanticSettingsRef.current.enabled) {
      updatePdfTab(tab.id, {
        semanticResults: [],
        semanticHighlight: null
      });
      return;
    }

    const semanticResults = await searchSemanticDocument({
      bytes: currentTab.bytes,
      query: normalizedQuery,
      settings: semanticSettingsRef.current
    });
    if (requestId !== searchRequestIdRef.current) return;
    updatePdfTab(tab.id, { semanticResults });
  }, [clearTabSearch, updateMarkdownTab, updatePdfTab]);

  useEffect(() => {
    if (autoSearchTimerRef.current !== null) {
      window.clearTimeout(autoSearchTimerRef.current);
      autoSearchTimerRef.current = null;
    }

    if (!activeTabId) return undefined;

    const activeSearchTab = tabsRef.current.find((tab) => tab.id === activeTabId) ?? null;
    if (!activeSearchTab) return undefined;

    const normalizedQuery = searchText.trim();
    if (normalizedQuery.length < 3) {
      searchRequestIdRef.current += 1;
      if (activeSearchTab.searchQuery || activeSearchTab.searchMatches.length > 0) {
        clearTabSearch(activeSearchTab);
      }
      setSidebar((current) => (current === "semantic" ? null : current));
      return undefined;
    }

    autoSearchTimerRef.current = window.setTimeout(() => {
      const latestTab = tabsRef.current.find((tab) => tab.id === activeTabId) ?? null;
      if (latestTab) void applySearch(latestTab, normalizedQuery);
    }, 250);

    return () => {
      if (autoSearchTimerRef.current !== null) {
        window.clearTimeout(autoSearchTimerRef.current);
        autoSearchTimerRef.current = null;
      }
    };
  }, [activeTabId, activePdfTab?.pdfDoc, activePdfTab?.ocrPages, activeMarkdownText, searchText, applySearch, clearTabSearch]);

  const runSearch = async () => {
    if (!activeTab) return;
    if (autoSearchTimerRef.current !== null) {
      window.clearTimeout(autoSearchTimerRef.current);
      autoSearchTimerRef.current = null;
    }
    await applySearch(activeTab, searchText, true, true);
  };

  const stepSearch = (direction: 1 | -1) => {
    if (!activeTab || activeTab.searchMatches.length === 0) return;
    const nextIndex =
      (activeTab.activeSearchMatch + direction + activeTab.searchMatches.length) % activeTab.searchMatches.length;
    if (isPdfTab(activeTab)) {
      updatePdfTab(activeTab.id, {
        activeSearchMatch: nextIndex,
        currentPage: activeTab.searchMatches[nextIndex].page,
        semanticHighlight: null
      });
      return;
    }
    updateMarkdownTab(activeTab.id, { activeSearchMatch: nextIndex });
  };

  const clearSearch = () => {
    searchRequestIdRef.current += 1;
    if (autoSearchTimerRef.current !== null) {
      window.clearTimeout(autoSearchTimerRef.current);
      autoSearchTimerRef.current = null;
    }
    setSearchText("");
    if (!activeTab) return;
    clearTabSearch(activeTab);
    setSidebar((current) => (current === "semantic" ? null : current));
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  };

  const selectedOverlay = activePdfTab?.overlays.find((overlay) => overlay.id === selectedOverlayId) ?? null;

  const focusSearch = useCallback(() => {
    setSearchExpanded(true);
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  useEffect(() => {
    if (selectedOverlay?.kind !== "comment" || !selectedOverlay.minimized) return undefined;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".comment-popup, .comment-pin")) return;
      setSelectedOverlayId(null);
    };

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [selectedOverlay]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT";
      const shortcut = event.metaKey || event.ctrlKey;

      if (shortcut && (event.key.toLowerCase() === "f" || event.key.toLowerCase() === "k")) {
        event.preventDefault();
        focusSearch();
        return;
      }

      if (shortcut && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!activePdfTab) return;
        void saveActiveTab(false, false);
        return;
      }

      if (shortcut && event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault();
        if (!activePdfTab) return;
        void undoActiveTab();
        return;
      }

      if (shortcut && (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey))) {
        event.preventDefault();
        if (!activePdfTab) return;
        void redoActiveTab();
        return;
      }

      if (shortcut && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        if (!activePdfTab) return;
        updatePdfTab(activePdfTab.id, { zoom: Math.min(4, activePdfTab.zoom + 0.1), fitMode: "actual" });
        return;
      }

      if (shortcut && event.key === "-") {
        event.preventDefault();
        if (!activePdfTab) return;
        updatePdfTab(activePdfTab.id, { zoom: Math.max(0.25, activePdfTab.zoom - 0.1), fitMode: "actual" });
        return;
      }

      if (shortcut && event.key === "0") {
        event.preventDefault();
        if (!activePdfTab) return;
        updatePdfTab(activePdfTab.id, { zoom: 1, fitMode: "actual" });
        return;
      }

      if (!activePdfTab) return;
      if (isTyping) return;

      if (selectedOverlayId && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        deleteOverlay(selectedOverlayId);
        return;
      }

      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        updatePdfTab(activePdfTab.id, { currentPage: Math.max(1, activePdfTab.currentPage - 1) });
      }

      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        updatePdfTab(activePdfTab.id, { currentPage: Math.min(activePdfTab.pageCount, activePdfTab.currentPage + 1) });
      }

      if (event.key === "Escape") {
        setTool("select");
        setSelectedOverlayId(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePdfTab, selectedOverlayId, updatePdfTab, focusSearch]);

  const semanticToolbarProgress =
    semanticModelDownloadProgress ??
    (activePdfTab?.semanticIndexStatus &&
    activePdfTab.semanticIndexStatus !== "idle" &&
    activePdfTab.semanticIndexStatus !== "ready"
      ? activePdfTab.semanticIndexProgress
      : null);
  const documentStage = (
    <section className="document-stage" ref={workspaceRef}>
      {!activeTab ? (
        <EmptyState
          onOpen={openFromDialog}
          recentFiles={recentFiles}
          onOpenRecent={(path) => void openFilePaths([path])}
          onRemoveRecent={(path) => void removeRecentFile(path)}
        />
      ) : (
        <DocumentView
          tab={activeTab}
          tool={tool}
          selectedOverlayId={selectedOverlayId}
          onPageClick={addOverlay}
          onSelectOverlay={setSelectedOverlayId}
          onUpdateOverlay={updateOverlay}
          onDeleteOverlay={deleteOverlay}
          onTextSelection={setSelectionAction}
          onClearSemanticHighlight={() => activePdfTab && updatePdfTab(activePdfTab.id, { semanticHighlight: null })}
          onWheelPage={(direction) => {
            if (!activePdfTab) return;
            const nextPage = Math.min(activePdfTab.pageCount, Math.max(1, activePdfTab.currentPage + direction));
            if (nextPage !== activePdfTab.currentPage) updatePdfTab(activePdfTab.id, { currentPage: nextPage });
          }}
        />
      )}
    </section>
  );

  return (
    <div className="app-shell" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
      <TopBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={setActiveTabId}
        onCloseTab={closeTab}
        onOpen={openFromDialog}
        onSave={() => void saveActiveTab(false, false)}
        onSaveAs={() => void saveActiveTab(true, false)}
        onSaveMarkdown={() => void saveActiveTabAsMarkdown()}
        onExportFlattened={() => void saveActiveTab(true, true)}
        onPrint={() => void printActiveTab()}
        canSavePdf={Boolean(activePdfTab)}
        canSaveMarkdown={Boolean(activePdfTab)}
        canPrint={Boolean(activePdfTab)}
        theme={theme}
        onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        isFullScreen={isFullScreen}
        onToggleFullScreen={() => void toggleFullScreen()}
        onOpenSettings={() => setSettingsOpen(true)}
        recentFiles={recentFiles}
        onOpenRecent={(path) => void openFilePaths([path])}
        onClearRecent={async () => {
          if (!window.pdfReader) return;
          setRecentFiles(await window.pdfReader.clearRecentFiles());
        }}
        openMenu={openMenu}
        onOpenMenu={openToolbarMenu}
        onCloseMenu={scheduleToolbarMenuClose}
      />

      <div className="toolbar">
        <button
          className="icon-button"
          title="Pages"
          disabled={!activePdfTab}
          onClick={() => setSidebar(sidebar === "pages" ? null : "pages")}
        >
          <PanelLeft size={18} />
        </button>
        <div className="divider" />
        <ToolButton active={tool === "select"} title="Select text" onClick={() => setTool("select")}>
          <MousePointer2 size={18} />
        </ToolButton>
        <ToolButton active={tool === "text"} title="Add text" disabled={!activePdfTab} onClick={() => setTool("text")}>
          <Type size={18} />
        </ToolButton>
        <ToolButton
          active={tool === "signature"}
          title="Sign"
          disabled={!activePdfTab}
          onClick={() => {
            setTool("signature");
            setSidebar("signature");
          }}
        >
          <Signature size={18} />
        </ToolButton>
        <div className="toolbar-center">
          <button
            className="icon-button"
            title="Previous page"
            disabled={!activePdfTab || activePdfTab.currentPage <= 1}
            onClick={() => activePdfTab && updatePdfTab(activePdfTab.id, { currentPage: activePdfTab.currentPage - 1 })}
          >
            <ChevronLeft size={18} />
          </button>
          <PageBox tab={activePdfTab} onChange={(page) => activePdfTab && updatePdfTab(activePdfTab.id, { currentPage: page })} />
          <button
            className="icon-button"
            title="Next page"
            disabled={!activePdfTab || activePdfTab.currentPage >= activePdfTab.pageCount}
            onClick={() => activePdfTab && updatePdfTab(activePdfTab.id, { currentPage: activePdfTab.currentPage + 1 })}
          >
            <ChevronRight size={18} />
          </button>
          <button
            className="icon-button"
            title="Rotate page view"
            disabled={!activePdfTab}
            onClick={() => activePdfTab && updatePdfTab(activePdfTab.id, { rotation: (activePdfTab.rotation + 90) % 360 })}
          >
            <RotateCw size={18} />
          </button>
          <div className="divider" />
          <div className="zoom-control">
            <button
              className="icon-button"
              title="Zoom out"
              disabled={!activePdfTab}
              onClick={() => activePdfTab && updatePdfTab(activePdfTab.id, { zoom: Math.max(0.25, activePdfTab.zoom - 0.1), fitMode: "actual" })}
            >
              <Minus size={18} />
            </button>
            <span className="zoom-label">{activePdfTab ? `${Math.round(activePdfTab.zoom * 100)}%` : "100%"}</span>
            <button
              className="icon-button"
              title="Zoom in"
              disabled={!activePdfTab}
              onClick={() => activePdfTab && updatePdfTab(activePdfTab.id, { zoom: Math.min(4, activePdfTab.zoom + 0.1), fitMode: "actual" })}
            >
              <Plus size={18} />
            </button>
          </div>
          <FitMenu
            activeTab={activePdfTab}
            openMenu={openMenu}
            onOpenMenu={openToolbarMenu}
            onCloseMenu={scheduleToolbarMenuClose}
            onFit={(mode) => {
              void applyFitMode(mode);
              openToolbarMenu(null);
            }}
          />
          <ViewMenu
            activeTab={activePdfTab}
            onChange={(patch) => {
              if (activePdfTab) updatePdfTab(activePdfTab.id, patch);
              openToolbarMenu(null);
            }}
            isFullScreen={isFullScreen}
            onToggleFullScreen={() => {
              void toggleFullScreen();
              openToolbarMenu(null);
            }}
            openMenu={openMenu}
            onOpenMenu={openToolbarMenu}
            onCloseMenu={scheduleToolbarMenuClose}
          />
        </div>
        <div className="toolbar-spacer" />
        <div
          className={`search-box ${searchExpanded || searchText ? "active" : ""}`}
          title="Find text"
          onMouseEnter={() => {
            clearSearchCloseTimer();
            searchPinnedRef.current = false;
            setSearchExpanded(true);
            searchInputRef.current?.focus();
          }}
          onMouseLeave={scheduleSearchClose}
          onClick={() => {
            clearSearchCloseTimer();
            searchPinnedRef.current = true;
            setSearchExpanded(true);
            searchInputRef.current?.focus();
          }}
        >
          <Search size={15} />
          <input
            ref={searchInputRef}
            value={searchText}
            onChange={(event) => {
              clearSearchCloseTimer();
              searchPinnedRef.current = true;
              setSearchText(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (event.shiftKey) stepSearch(-1);
                else void runSearch();
              }
            }}
            placeholder="Find text"
          />
          {(searchText || activeTab?.searchQuery) && (
            <button
              className="search-clear-button"
              title="Clear search"
              aria-label="Clear search"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                searchPinnedRef.current = false;
                clearSearch();
              }}
            >
              <X size={13} />
            </button>
          )}
        </div>
        {(searchText || activeTab?.searchQuery) && (
          <>
            <button className="icon-button" title="Previous match" disabled={!activeTab?.searchMatches.length} onClick={() => stepSearch(-1)}>
              <ChevronLeft size={16} />
            </button>
            <button className="icon-button" title="Next match" disabled={!activeTab?.searchMatches.length} onClick={() => stepSearch(1)}>
              <ChevronRight size={16} />
            </button>
            <span className="search-count">
              {activeTab?.searchMatches.length
                ? `${activeTab.activeSearchMatch + 1}/${activeTab.searchMatches.length}`
                : activeTab?.searchQuery
                  ? "0/0"
                  : ""}
            </span>
          </>
        )}
        {activePdfTab?.ocrStatus && activePdfTab.ocrStatus !== "skipped" && (
          <span className={`ocr-status ${activePdfTab.ocrStatus}`} title={activePdfTab.ocrError ?? activePdfTab.ocrProgress?.message ?? "OCR status"}>
            <ScanText size={14} />
            <span>{formatOcrStatus(activePdfTab)}</span>
          </span>
        )}
        {semanticToolbarProgress &&
          semanticToolbarProgress.status !== "idle" &&
          semanticToolbarProgress.status !== "ready" &&
          semanticToolbarProgress.status !== "error" && (
          <span
            className={`ocr-status semantic ${semanticToolbarProgress.status}`}
            title={activePdfTab?.semanticIndexError ?? semanticToolbarProgress.message ?? "Semantic index status"}
          >
            <span>{formatSemanticProgress(semanticToolbarProgress)}</span>
            {(semanticToolbarProgress.status === "downloading" || semanticToolbarProgress.status === "indexing") && (
              <span className="status-progress-bar">
                <span style={{ width: `${semanticProgressPercent(semanticToolbarProgress)}%` }} />
              </span>
            )}
          </span>
        )}
      </div>

      <main className="workspace">
        {selectionAction && (
          <div
            className="selection-popover"
            style={{
              left: selectionAction.screenX,
              top: selectionAction.screenY
            }}
          >
            <button title="Highlight selection" onMouseDown={(event) => event.preventDefault()} onClick={() => addSelectionOverlay("highlight")}>
              <Highlighter size={16} />
            </button>
            <button title="Comment on selection" onMouseDown={(event) => event.preventDefault()} onClick={() => addSelectionOverlay("comment")}>
              <MessageSquarePlus size={16} />
            </button>
          </div>
        )}

        {activePdfTab && sidebar === "semantic" ? (
          <ResizablePanelGroup orientation="horizontal" className="workspace-resizable" resizeTargetMinimumSize={{ coarse: 28, fine: 10 }}>
            <ResizablePanel id="document" className="document-resizable-panel" defaultSize="75%" minSize="50%">
              {documentStage}
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="semantic-search" className="semantic-resizable-panel" defaultSize="25%" minSize="18%" maxSize="50%">
              <Sidebar
                mode={sidebar}
                tab={activePdfTab}
                selectedOverlay={selectedOverlay}
                signatureText={signatureText}
                signatureFont={signatureFont}
                savedSignatures={savedSignatures}
                selectedSignatureId={selectedSignature?.id ?? null}
                onSelectPage={(page) => activePdfTab && updatePdfTab(activePdfTab.id, { currentPage: page })}
                onUpdateOverlay={updateOverlay}
                onDeleteOverlay={deleteOverlay}
                onUpdateFormField={updateFormField}
                onInsertPage={() => void insertPageAfterCurrent()}
                onDeletePage={() => void deleteCurrentPage()}
                onMovePage={(direction) => void moveCurrentPage(direction)}
                onReorderPage={(fromPage, toPage) => void movePageTo(fromPage, toPage)}
                onSignatureText={setSignatureText}
                onSignatureFont={setSignatureFont}
                onSaveTypedSignature={() => undefined}
                onSelectSignature={() => undefined}
                onDeleteSignature={() => undefined}
                onSaveSignatureAsset={() => undefined}
                onOpenDrawingSignature={() => undefined}
                onSelectSemanticResult={(result) => {
                  updatePdfTab(activePdfTab.id, {
                    currentPage: result.page,
                    semanticHighlight: {
                      page: result.page,
                      text: result.snippet,
                      id: result.id
                    }
                  });
                }}
                onModeChange={setSidebar}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <>
            {activePdfTab && sidebar && (
              <Sidebar
                mode={sidebar}
                tab={activePdfTab}
                selectedOverlay={selectedOverlay}
                signatureText={signatureText}
                signatureFont={signatureFont}
                savedSignatures={savedSignatures}
                selectedSignatureId={selectedSignature?.id ?? null}
                onSelectPage={(page) => activePdfTab && updatePdfTab(activePdfTab.id, { currentPage: page })}
                onUpdateOverlay={updateOverlay}
                onDeleteOverlay={deleteOverlay}
                onUpdateFormField={updateFormField}
                onInsertPage={() => void insertPageAfterCurrent()}
                onDeletePage={() => void deleteCurrentPage()}
                onMovePage={(direction) => void moveCurrentPage(direction)}
                onReorderPage={(fromPage, toPage) => void movePageTo(fromPage, toPage)}
                onSignatureText={setSignatureText}
                onSignatureFont={setSignatureFont}
                onSaveTypedSignature={() => {
                  const nextAssets = createTypedSignatureAssets(signatureText, signatureFont);
                  if (!nextAssets.length) return;
                  setSavedSignatures((current) => [...nextAssets, ...current]);
                  setSelectedSignatureId(nextAssets[0].id);
                  setSelectedOverlayId(null);
                  setTool("signature");
                }}
                onSelectSignature={(id) => {
                  setSelectedSignatureId(id);
                  setSelectedOverlayId(null);
                  setTool("signature");
                }}
                onDeleteSignature={(id) => {
                  setSavedSignatures((current) => current.filter((asset) => asset.id !== id));
                }}
                onSaveSignatureAsset={(asset) => {
                  setSavedSignatures((current) => [asset, ...current]);
                  setSelectedSignatureId(asset.id);
                  setSelectedOverlayId(null);
                  setTool("signature");
                }}
                onOpenDrawingSignature={() => setDrawingSignatureOpen(true)}
                onSelectSemanticResult={() => undefined}
                onModeChange={setSidebar}
              />
            )}
            {documentStage}
          </>
        )}
      </main>

      {drawingSignatureOpen && (
        <DrawingSignatureModal
          onCancel={() => setDrawingSignatureOpen(false)}
          onSave={(dataUrl, width, height) => {
            const asset: SignatureAsset = {
              id: newId("signature-drawn"),
              kind: "drawn",
              label: "Drawn signature",
              dataUrl,
              width,
              height,
              createdAt: new Date().toISOString()
            };
            setSavedSignatures((current) => [asset, ...current]);
            setSelectedSignatureId(asset.id);
            setDrawingSignatureOpen(false);
          }}
        />
      )}

      {signatureSavePrompt && (
        <SignatureSavePrompt
          name={signatureSavePrompt.name}
          onChoose={(choice) => {
            signatureSavePrompt.resolve(choice);
            setSignatureSavePrompt(null);
          }}
        />
      )}

      {operationProgress && <OperationProgressDialog progress={operationProgress} />}

      {settingsOpen && (
        <AISettingsDialog
          onClose={() => setSettingsOpen(false)}
          onSemanticSettingsChange={applySemanticSettings}
          onSemanticIndexCleared={resetSemanticTabs}
        />
      )}
    </div>
  );
}

function formatOcrStatus(tab: PdfTab) {
  if (tab.ocrStatus === "ready") return "OCR ready";
  if (tab.ocrStatus === "error") return "OCR failed";
  if (tab.ocrStatus === "checking") return "Checking OCR";
  const page = tab.ocrProgress?.page;
  const totalPages = tab.ocrProgress?.totalPages;
  return page && totalPages ? `OCR ${page}/${totalPages}` : "OCR running";
}

function formatSemanticProgress(progress: NonNullable<PdfTab["semanticIndexProgress"]>) {
  if (progress.status === "error") return "Index failed";
  if (progress.status === "downloading") return "Downloading model";
  if (progress.status === "checking") return "Checking index";
  const current = progress.current;
  const total = progress.total;
  return current && total ? `Index ${current}/${total}` : "Indexing";
}

function semanticProgressPercent(progress: NonNullable<PdfTab["semanticIndexProgress"]>) {
  if (progress.status === "downloading" && progress.current && progress.total) {
    return Math.min(100, Math.max(4, Math.round((progress.current / progress.total) * 100)));
  }
  if (progress.status === "indexing" && progress.current && progress.total) {
    return Math.min(100, Math.max(4, Math.round((progress.current / progress.total) * 100)));
  }
  return progress.status === "error" ? 100 : 18;
}

function downloadBytes(bytes: Uint8Array, name: string) {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const url = URL.createObjectURL(new Blob([buffer], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadText(text: string, name: string, mimeType: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function OperationProgressDialog({ progress }: { progress: OperationProgress }) {
  const hasTotal = typeof progress.total === "number" && progress.total > 0;
  const current = hasTotal ? Math.min(progress.current ?? 0, progress.total ?? 0) : 0;
  const percent = hasTotal ? Math.round((current / (progress.total ?? 1)) * 100) : 0;

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="operation-progress-modal" role="dialog" aria-modal="true" aria-labelledby="operation-progress-title">
        <h2 id="operation-progress-title">{progress.title}</h2>
        <p>{progress.message}</p>
        <div className="operation-progress-bar" aria-label={hasTotal ? `${percent}% complete` : "Working"}>
          <span style={{ width: `${hasTotal ? percent : 24}%` }} />
        </div>
        {hasTotal && (
          <small>
            {current} / {progress.total}
          </small>
        )}
      </div>
    </div>
  );
}

function TopBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onOpen,
  onSave,
  onSaveAs,
  onSaveMarkdown,
  onExportFlattened,
  onPrint,
  canSavePdf,
  canSaveMarkdown,
  canPrint,
  theme,
  onToggleTheme,
  isFullScreen,
  onToggleFullScreen,
  onOpenSettings,
  recentFiles,
  onOpenRecent,
  onClearRecent,
  openMenu,
  onOpenMenu,
  onCloseMenu
}: {
  tabs: DocumentTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onSaveMarkdown: () => void;
  onExportFlattened: () => void;
  onPrint: () => void;
  canSavePdf: boolean;
  canSaveMarkdown: boolean;
  canPrint: boolean;
  theme: ThemeMode;
  onToggleTheme: () => void;
  isFullScreen: boolean;
  onToggleFullScreen: () => void;
  onOpenSettings: () => void;
  recentFiles: string[];
  onOpenRecent: (path: string) => void;
  onClearRecent: () => void;
  openMenu: ToolbarMenu | null;
  onOpenMenu: (menu: ToolbarMenu | null) => void;
  onCloseMenu: () => void;
}) {
  return (
    <header className="top-bar">
      <div className="tabs">
        {tabs.map((tab) => (
          <button
            className={`tab ${tab.id === activeTabId ? "active" : ""}`}
            key={tab.id}
            onClick={() => onSelectTab(tab.id)}
            title={tab.path ?? tab.name}
          >
            <FileText size={16} />
            <span>{tab.name}</span>
            {tab.dirty && <i />}
            <span
              className="tab-close-icon"
              title={`Close ${tab.name}`}
              aria-label={`Close ${tab.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onCloseTab(tab.id);
              }}
            >
              <X size={14} />
            </span>
          </button>
        ))}
      </div>
      <div className="top-actions">
        <button className="icon-button" title="Open" aria-label="Open" onClick={onOpen}>
          <FolderOpen size={17} />
        </button>
        <div
          className={`menu-button ${openMenu === "recent" ? "open" : ""}`}
          onMouseEnter={() => recentFiles.length > 0 && onOpenMenu("recent")}
          onMouseLeave={onCloseMenu}
        >
          <button
            className="text-button menu-trigger"
            title="Recent files"
            disabled={recentFiles.length === 0}
            onClick={() => recentFiles.length > 0 && onOpenMenu(openMenu === "recent" ? null : "recent")}
          >
            Recent
            <ChevronDown size={15} />
          </button>
          {recentFiles.length > 0 && (
            <div className="menu-popover right wide">
              {recentFiles.map((path) => (
                <button key={path} onClick={() => onOpenRecent(path)} title={path}>
                  <span className="menu-title">{truncateMiddle(fileNameFromPath(path), 36)}</span>
                </button>
              ))}
              <button onClick={onClearRecent}>Clear recent files</button>
            </div>
          )}
        </div>
        <button className="icon-button" title="Save" onClick={onSave} disabled={!canSavePdf}>
          <Save size={17} />
        </button>
        <div
          className={`menu-button ${openMenu === "save" ? "open" : ""}`}
          onMouseEnter={() => canSavePdf && onOpenMenu("save")}
          onMouseLeave={onCloseMenu}
        >
          <button
            className="icon-button menu-trigger"
            title="Save options"
            disabled={!canSavePdf}
            onClick={() => canSavePdf && onOpenMenu(openMenu === "save" ? null : "save")}
          >
            <ChevronDown size={17} />
          </button>
          {canSavePdf && (
            <div className="menu-popover right">
              <button onClick={onSaveAs}>Save as</button>
              <button disabled={!canSaveMarkdown} onClick={onSaveMarkdown}>Save as Markdown</button>
              <button onClick={onExportFlattened}>Export flattened PDF</button>
            </div>
          )}
        </div>
        <button className="icon-button" title="Print" onClick={onPrint} disabled={!canPrint}>
          <Printer size={17} />
        </button>
        <button className="icon-button" title="Toggle theme" onClick={onToggleTheme}>
          {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <button className="icon-button" title={isFullScreen ? "Exit full screen" : "Full screen"} onClick={onToggleFullScreen}>
          {isFullScreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
        </button>
        <button className="icon-button" title="Settings" onClick={onOpenSettings}>
          <SettingsIcon size={17} />
        </button>
      </div>
    </header>
  );
}

function ToolButton({
  active,
  title,
  disabled,
  onClick,
  children
}: {
  active: boolean;
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button className={`icon-button ${active ? "active" : ""}`} title={title} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function PageBox({ tab, onChange }: { tab: PdfTab | null; onChange: (page: number) => void }) {
  const [value, setValue] = useState("1");

  useEffect(() => setValue(String(tab?.currentPage ?? 1)), [tab?.currentPage]);

  return (
    <div className="page-box">
      <input
        value={value}
        disabled={!tab}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          if (!tab) return;
          const next = Math.min(tab.pageCount, Math.max(1, Number(value) || tab.currentPage));
          onChange(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
      />
      <span>/{tab?.pageCount ?? 0}</span>
    </div>
  );
}

function FitMenu({
  activeTab,
  openMenu,
  onOpenMenu,
  onCloseMenu,
  onFit
}: {
  activeTab: PdfTab | null;
  openMenu: ToolbarMenu | null;
  onOpenMenu: (menu: ToolbarMenu | null) => void;
  onCloseMenu: () => void;
  onFit: (fitMode: FitMode) => void;
}) {
  const activeMode = activeTab?.fitMode ?? "page";
  const activeIcon =
    activeMode === "actual" ? (
      <ScanText size={18} />
    ) : activeMode === "width" ? (
      <StretchHorizontal size={18} />
    ) : activeMode === "height" ? (
      <StretchVertical size={18} />
    ) : (
      <Maximize2 size={18} />
    );

  return (
    <div
      className={`menu-button ${openMenu === "fit" ? "open" : ""}`}
      onMouseEnter={() => activeTab && onOpenMenu("fit")}
      onMouseLeave={onCloseMenu}
    >
      <button
        className="icon-button menu-trigger"
        title={activeMode === "actual" ? "Actual size" : `Fit ${activeMode}`}
        disabled={!activeTab}
        onClick={() => activeTab && onOpenMenu(openMenu === "fit" ? null : "fit")}
      >
        {activeIcon}
      </button>
      <div className="menu-popover">
        <MenuItem active={activeMode === "actual"} icon={<ScanText size={15} />} onClick={() => onFit("actual")}>
          Actual size
        </MenuItem>
        <MenuItem active={activeMode === "page"} icon={<Maximize2 size={15} />} onClick={() => onFit("page")}>
          Fit to page
        </MenuItem>
        <MenuItem active={activeMode === "width"} icon={<StretchHorizontal size={15} />} onClick={() => onFit("width")}>
          Fit to width
        </MenuItem>
        <MenuItem active={activeMode === "height"} icon={<StretchVertical size={15} />} onClick={() => onFit("height")}>
          Fit height
        </MenuItem>
      </div>
    </div>
  );
}

function ViewMenu({
  activeTab,
  onChange,
  isFullScreen,
  onToggleFullScreen,
  openMenu,
  onOpenMenu,
  onCloseMenu
}: {
  activeTab: PdfTab | null;
  onChange: (patch: Partial<PdfTab>) => void;
  isFullScreen: boolean;
  onToggleFullScreen: () => void;
  openMenu: ToolbarMenu | null;
  onOpenMenu: (menu: ToolbarMenu | null) => void;
  onCloseMenu: () => void;
}) {
  const activeViewIcon = activeTab?.viewMode === "two" ? <Columns2 size={18} /> : <FileText size={18} />;

  return (
    <div
      className={`menu-button ${openMenu === "view" ? "open" : ""}`}
      onMouseEnter={() => activeTab && onOpenMenu("view")}
      onMouseLeave={onCloseMenu}
    >
      <button
        className="icon-button menu-trigger"
        title={activeTab?.viewMode === "two" ? "Two-page view" : "Single-page view"}
        disabled={!activeTab}
        onClick={() => activeTab && onOpenMenu(openMenu === "view" ? null : "view")}
      >
        {activeViewIcon}
      </button>
      <div className="menu-popover">
        <MenuItem active={activeTab?.viewMode === "single"} icon={<FileText size={15} />} onClick={() => onChange({ viewMode: "single" })}>
          Single-page view
        </MenuItem>
        <MenuItem active={activeTab?.viewMode === "two"} icon={<Columns2 size={15} />} onClick={() => onChange({ viewMode: "two" })}>
          Two-page view
        </MenuItem>
        <MenuItem active={activeTab?.scrolling} icon={<ScrollText size={15} />} onClick={() => onChange({ scrolling: !activeTab?.scrolling })}>
          Enable scrolling
        </MenuItem>
        <MenuItem active={isFullScreen} icon={<Maximize2 size={15} />} onClick={onToggleFullScreen}>
          Full screen mode
        </MenuItem>
      </div>
    </div>
  );
}

function MenuItem({
  active,
  icon,
  children,
  onClick
}: {
  active?: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick}>
      <span className="menu-item-icon">{icon}</span>
      <span>{children}</span>
      <span className="menu-check">{active && <Check size={14} />}</span>
    </button>
  );
}

function EmptyState({
  onOpen,
  recentFiles,
  onOpenRecent,
  onRemoveRecent
}: {
  onOpen: () => void;
  recentFiles: string[];
  onOpenRecent: (path: string) => void;
  onRemoveRecent: (path: string) => void;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icons">
        <FileText size={42} />
        <ImageIcon size={34} />
      </div>
      <h1>MarkPDF</h1>
      <p>Open or drop PDFs, or import images to create a PDF.</p>
      <button className="primary-button" onClick={onOpen}>
        <FilePlus2 size={18} />
        Open Files
      </button>
      {recentFiles.length > 0 && (
        <div className="recent-empty">
          <h2>Recent</h2>
          {recentFiles.slice(0, 5).map((path) => (
            <div className="recent-empty-row" key={path}>
              <button className="recent-empty-open" onClick={() => onOpenRecent(path)} title={path}>
                {fileNameFromPath(path)}
              </button>
              <button
                className="recent-empty-remove"
                onClick={() => onRemoveRecent(path)}
                title="Remove from recent files"
                aria-label={`Remove ${fileNameFromPath(path)} from recent files`}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function fileNameFromPath(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function truncateMiddle(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  const keep = Math.max(6, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

async function copyTextToClipboard(value: string) {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

function extractSelectedTextFromLayer(textLayer: HTMLElement, selectionRects: DOMRect[]) {
  const spans = Array.from(textLayer.querySelectorAll("span"))
    .map((span) => {
      const rect = span.getBoundingClientRect();
      const overlap = Math.max(...selectionRects.map((selectionRect) => rectangleOverlapRatio(rect, selectionRect)), 0);
      return overlap >= 0.45
        ? {
            text: span.textContent?.trim() ?? "",
            top: rect.top,
            left: rect.left
          }
        : null;
    })
    .filter((item): item is { text: string; top: number; left: number } => Boolean(item?.text))
    .sort((a, b) => (Math.abs(a.top - b.top) > 4 ? a.top - b.top : a.left - b.left));

  return spans.map((span) => span.text).join(" ").replace(/\s+/g, " ").trim();
}

function rectangleOverlapRatio(a: DOMRect, b: DOMRect) {
  const xOverlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const yOverlap = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const overlapArea = xOverlap * yOverlap;
  const spanArea = Math.max(1, a.width * a.height);
  return overlapArea / spanArea;
}

function DocumentView({
  tab,
  tool,
  selectedOverlayId,
  onPageClick,
  onSelectOverlay,
  onUpdateOverlay,
  onDeleteOverlay,
  onTextSelection,
  onClearSemanticHighlight,
  onWheelPage
}: {
  tab: DocumentTab;
  tool: ToolMode;
  selectedOverlayId: string | null;
  onPageClick: (page: number, x: number, y: number) => void;
  onSelectOverlay: (id: string | null) => void;
  onUpdateOverlay: (id: string, patch: Partial<OverlayItem>, recordHistory?: boolean) => void;
  onDeleteOverlay: (id: string) => void;
  onTextSelection: (selection: {
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
    screenX: number;
    screenY: number;
    text: string;
  } | null) => void;
  onClearSemanticHighlight: () => void;
  onWheelPage: (direction: -1 | 1) => void;
}) {
  if (isMarkdownTab(tab)) {
    return <MarkdownDocumentView tab={tab} />;
  }

  return (
    <PdfDocumentView
      tab={tab}
      tool={tool}
      selectedOverlayId={selectedOverlayId}
      onPageClick={onPageClick}
      onSelectOverlay={onSelectOverlay}
      onUpdateOverlay={onUpdateOverlay}
      onDeleteOverlay={onDeleteOverlay}
      onTextSelection={onTextSelection}
      onClearSemanticHighlight={onClearSemanticHighlight}
      onWheelPage={onWheelPage}
    />
  );
}

function PdfDocumentView({
  tab,
  tool,
  selectedOverlayId,
  onPageClick,
  onSelectOverlay,
  onUpdateOverlay,
  onDeleteOverlay,
  onTextSelection,
  onClearSemanticHighlight,
  onWheelPage
}: {
  tab: PdfTab;
  tool: ToolMode;
  selectedOverlayId: string | null;
  onPageClick: (page: number, x: number, y: number) => void;
  onSelectOverlay: (id: string | null) => void;
  onUpdateOverlay: (id: string, patch: Partial<OverlayItem>, recordHistory?: boolean) => void;
  onDeleteOverlay: (id: string) => void;
  onTextSelection: (selection: {
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
    screenX: number;
    screenY: number;
    text: string;
  } | null) => void;
  onClearSemanticHighlight: () => void;
  onWheelPage: (direction: -1 | 1) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pages = tab.scrolling
    ? Array.from({ length: tab.pageCount }, (_, index) => index + 1)
    : tab.viewMode === "two" && tab.currentPage < tab.pageCount
      ? [tab.currentPage, tab.currentPage + 1]
      : [tab.currentPage];
  const activeSearchMatch = tab.semanticHighlight ? null : (tab.searchMatches[tab.activeSearchMatch] ?? null);
  const activeSearchMatchOrdinal = activeSearchMatch
    ? tab.searchMatches
        .slice(0, tab.activeSearchMatch)
        .filter((match) => match.page === activeSearchMatch.page).length
    : -1;

  useEffect(() => {
    if (!tab.scrolling) return;
    const scrollPane = scrollRef.current;
    const pageElement = scrollPane?.querySelector(`[data-page-number="${tab.currentPage}"]`);
    if (!scrollPane) return;
    if (!(pageElement instanceof HTMLElement)) return;
    scrollPane.scrollTo({
      top: Math.max(0, pageElement.offsetTop - 28),
      left: 0,
      behavior: "smooth"
    });
  }, [tab.currentPage, tab.id, tab.scrolling]);

  return (
    <div
      ref={scrollRef}
      className={`document-scroll ${tab.viewMode === "two" && !tab.scrolling ? "two-up" : ""} ${!tab.scrolling ? "chrome-hidden" : ""}`}
      onWheelCapture={(event) => {
        const target = event.currentTarget;
        if (!tab.scrolling) {
          event.preventDefault();
          target.scrollTo({ top: 0, left: 0 });
          if (event.deltaY < 0) onWheelPage(-1);
          if (event.deltaY > 0) onWheelPage(1);
          return;
        }

        const canScrollVertically = target.scrollHeight > target.clientHeight;
        const canScrollHorizontally = target.scrollWidth > target.clientWidth;
        if (!canScrollVertically && !canScrollHorizontally) return;
        const atTop = target.scrollTop <= 0;
        const atBottom = Math.ceil(target.scrollTop + target.clientHeight) >= target.scrollHeight;
        event.preventDefault();
        if (event.deltaY < 0 && atTop) {
          onWheelPage(-1);
          return;
        }
        if (event.deltaY > 0 && atBottom) {
          onWheelPage(1);
          return;
        }
        target.scrollBy({ top: event.deltaY, left: event.deltaX });
      }}
    >
      {pages.map((pageNumber) => (
        <PdfPage
          key={`${tab.id}-${pageNumber}-${tab.rotation}`}
          pdfDoc={tab.pdfDoc}
          pageNumber={pageNumber}
          zoom={tab.zoom}
          rotation={tab.rotation}
          tool={tool}
          ocrPage={tab.ocrPages.find((page) => page.page === pageNumber) ?? null}
          overlays={tab.overlays.filter((overlay) => overlay.page === pageNumber)}
          activeSearchQuery={tab.searchQuery}
          activeSearchMatch={activeSearchMatch?.page === pageNumber ? activeSearchMatch : null}
          activeSearchMatchOrdinal={activeSearchMatch?.page === pageNumber ? activeSearchMatchOrdinal : -1}
          semanticHighlight={tab.semanticHighlight?.page === pageNumber ? tab.semanticHighlight : null}
          selectedOverlayId={selectedOverlayId}
          onPageClick={(x, y) => onPageClick(pageNumber, x, y)}
          onSelectOverlay={onSelectOverlay}
          onUpdateOverlay={onUpdateOverlay}
          onDeleteOverlay={onDeleteOverlay}
          onTextSelection={onTextSelection}
          onClearSemanticHighlight={onClearSemanticHighlight}
        />
      ))}
    </div>
  );
}

function MarkdownDocumentView({ tab }: { tab: MarkdownTab }) {
  return (
    <div className="markdown-document-scroll">
      <MarkdownPreview markdown={tab.markdown} searchQuery={tab.searchQuery} />
    </div>
  );
}

function PdfPage({
  pdfDoc,
  pageNumber,
  zoom,
  rotation,
  tool,
  ocrPage,
  overlays,
  activeSearchQuery,
  activeSearchMatch,
  activeSearchMatchOrdinal,
  semanticHighlight,
  selectedOverlayId,
  onPageClick,
  onSelectOverlay,
  onUpdateOverlay,
  onDeleteOverlay,
  onTextSelection,
  onClearSemanticHighlight
}: {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  rotation: number;
  tool: ToolMode;
  ocrPage: OcrPageText | null;
  overlays: OverlayItem[];
  activeSearchQuery: string;
  activeSearchMatch: SearchMatch | null;
  activeSearchMatchOrdinal: number;
  semanticHighlight: PdfTab["semanticHighlight"] | null;
  selectedOverlayId: string | null;
  onPageClick: (x: number, y: number) => void;
  onSelectOverlay: (id: string | null) => void;
  onUpdateOverlay: (id: string, patch: Partial<OverlayItem>) => void;
  onDeleteOverlay: (id: string) => void;
  onTextSelection: (selection: {
    page: number;
    x: number;
    y: number;
    width: number;
    height: number;
    screenX: number;
    screenY: number;
    text: string;
  } | null) => void;
  onClearSemanticHighlight: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const searchHighlightLayerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [renderError, setRenderError] = useState<string | null>(null);
  const [textLayerRenderKey, setTextLayerRenderKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let textLayer: TextLayer | null = null;

    async function renderPage() {
      try {
        setRenderError(null);
        const page = await pdfDoc.getPage(pageNumber);
        if (cancelled || !canvasRef.current || !textLayerRef.current) return;
        const viewport = page.getViewport({ scale: zoom, rotation });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) return;
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.clearRect(0, 0, viewport.width, viewport.height);
        setSize({ width: viewport.width, height: viewport.height });
        renderTask = page.render({ canvas, canvasContext: context, viewport, background: "white" });
        textLayerRef.current.replaceChildren();
        textLayer = new TextLayer({
          textContentSource: page.streamTextContent({ includeMarkedContent: true }),
          container: textLayerRef.current,
          viewport
        });
        await Promise.all([renderTask.promise, textLayer.render()]);
        if (!cancelled && rotation === 0 && textLayerRef.current) {
          appendOcrTextLayer(textLayerRef.current, ocrPage, zoom);
        }
        if (!cancelled) {
          setTextLayerRenderKey((key) => key + 1);
        }
      } catch (error) {
        if (!cancelled) {
          setRenderError(error instanceof Error ? error.message : "Page render failed.");
        }
      }
    }

    void renderPage();

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
    };
  }, [pdfDoc, pageNumber, rotation, zoom, ocrPage]);

  useEffect(() => {
    const highlightLayer = searchHighlightLayerRef.current;
    const textLayer = textLayerRef.current;
    highlightLayer?.replaceChildren();
    if (!highlightLayer || !textLayer) return;

    if (semanticHighlight) {
      const rects = getSemanticHighlightRects(textLayer, highlightLayer, semanticHighlight.text);

      for (const rect of rects) {
        const marker = document.createElement("div");
        marker.className = "semantic-hit active";
        marker.style.left = `${rect.left}px`;
        marker.style.top = `${rect.top}px`;
        marker.style.width = `${rect.width}px`;
        marker.style.height = `${rect.height}px`;
        highlightLayer.appendChild(marker);
      }

      const firstMarker = highlightLayer.firstElementChild;
      if (firstMarker) {
        window.requestAnimationFrame(() => {
          scrollSearchMarkerIntoDocumentPane(firstMarker);
        });
      }
      return;
    }

    if (!activeSearchMatch) return;

    const rects = getSearchHighlightRects(
      textLayer,
      highlightLayer,
      activeSearchQuery,
      activeSearchMatch,
      activeSearchMatchOrdinal
    );

    for (const rect of rects) {
      const marker = document.createElement("div");
      marker.className = "search-hit active";
      marker.style.left = `${rect.left}px`;
      marker.style.top = `${rect.top}px`;
      marker.style.width = `${rect.width}px`;
      marker.style.height = `${rect.height}px`;
      highlightLayer.appendChild(marker);
    }

    const firstMarker = highlightLayer.firstElementChild;
    if (firstMarker) {
      window.requestAnimationFrame(() => {
        scrollSearchMarkerIntoDocumentPane(firstMarker);
      });
    }
  }, [activeSearchMatch, activeSearchMatchOrdinal, activeSearchQuery, semanticHighlight, textLayerRenderKey]);

  return (
    <div className="page-wrap" data-page-number={pageNumber}>
      <div className="page-number-label">Page {pageNumber}</div>
      <div
        className={`pdf-page ${tool === "select" ? "selectable" : "editing"}`}
        style={{ width: size.width, height: size.height }}
        onMouseDown={() => {
          onTextSelection(null);
          onClearSemanticHighlight();
        }}
        onMouseUp={() => {
          if (tool !== "select") return;
          const selection = window.getSelection();
          if (!selection || selection.isCollapsed || !textLayerRef.current) {
            onTextSelection(null);
            return;
          }
          const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
          if (!range || !textLayerRef.current.contains(range.commonAncestorContainer)) return;
          const pageRect = textLayerRef.current.getBoundingClientRect();
          const rects = Array.from(range.getClientRects()).filter(
            (rect) => rect.width > 0 && rect.height > 0 && rect.bottom >= pageRect.top && rect.top <= pageRect.bottom
          );
          if (rects.length === 0) return;
          const left = Math.min(...rects.map((rect) => rect.left));
          const top = Math.min(...rects.map((rect) => rect.top));
          const right = Math.max(...rects.map((rect) => rect.right));
          const bottom = Math.max(...rects.map((rect) => rect.bottom));
          const selectedText = extractSelectedTextFromLayer(textLayerRef.current, rects) || selection.toString().trim();
          if (selectedText) void copyTextToClipboard(selectedText);
          onTextSelection({
            page: pageNumber,
            x: Math.max(0, (left - pageRect.left) / zoom),
            y: Math.max(0, (top - pageRect.top) / zoom),
            width: Math.max(12, (right - left) / zoom),
            height: Math.max(8, (bottom - top) / zoom),
            screenX: left + (right - left) / 2,
            screenY: Math.max(10, top - 10),
            text: selectedText
          });
        }}
        onClick={(event) => {
          if (tool === "select") return;
          const rect = event.currentTarget.getBoundingClientRect();
          onSelectOverlay(null);
          onPageClick((event.clientX - rect.left) / zoom, (event.clientY - rect.top) / zoom);
        }}
      >
        <canvas ref={canvasRef} />
        <div className="text-layer" ref={textLayerRef} />
        <div className="search-highlight-layer" ref={searchHighlightLayerRef} />
        {renderError && (
          <div className="render-error">
            <strong>Render failed</strong>
            <span>{renderError}</span>
          </div>
        )}
        <div className="overlay-layer">
          {overlays.map((overlay) => (
            <OverlayBox
              key={overlay.id}
              overlay={overlay}
              zoom={zoom}
              selected={selectedOverlayId === overlay.id}
              onSelect={() => onSelectOverlay(overlay.id)}
              onDeselect={() => onSelectOverlay(null)}
              onUpdate={(patch) => onUpdateOverlay(overlay.id, patch)}
              onDelete={() => onDeleteOverlay(overlay.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function getSearchHighlightRects(
  textLayer: HTMLDivElement,
  highlightLayer: HTMLDivElement,
  query: string,
  match: SearchMatch,
  matchOrdinal: number
) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const spacedSearchIndex = buildTextLayerSearchIndex(textLayer, true);
  const compactSearchIndex = buildTextLayerSearchIndex(textLayer, false);
  const matchLocation =
    findSearchMatchLocation(spacedSearchIndex, normalizedQuery, match.index, matchOrdinal) ??
    findSearchMatchLocation(compactSearchIndex, normalizedQuery, match.index, matchOrdinal);

  if (!matchLocation) return [];

  const matchEnd = matchLocation.start + normalizedQuery.length;
  const rangesBySpan = new Map<HTMLSpanElement, { start: number; end: number }>();

  for (let index = matchLocation.start; index < matchEnd; index += 1) {
    const position = matchLocation.searchIndex.positions[index];
    if (!position) continue;
    const existing = rangesBySpan.get(position.span);
    if (existing) {
      existing.start = Math.min(existing.start, position.offset);
      existing.end = Math.max(existing.end, position.offset + 1);
    } else {
      rangesBySpan.set(position.span, { start: position.offset, end: position.offset + 1 });
    }
  }

  const layerRect = highlightLayer.getBoundingClientRect();
  return Array.from(rangesBySpan.entries()).map(([span, range]) =>
    spanRangeToLayerRect(span, range.start, range.end, layerRect)
  );
}

function getSemanticHighlightRects(textLayer: HTMLDivElement, highlightLayer: HTMLDivElement, text: string) {
  const normalizedText = text
    .replace(/\.\.\.$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalizedText) return [];

  const searchIndex = buildTextLayerSearchIndex(textLayer, true);
  const layerText = searchIndex.text.toLowerCase();
  const candidateQueries = [
    normalizedText.split(/\s+/).slice(0, 12).join(" "),
    normalizedText.split(/\s+/).slice(0, 8).join(" "),
    normalizedText.split(/\s+/).slice(4, 14).join(" "),
    normalizedText.split(/\s+/).slice(8, 18).join(" ")
  ].filter((query) => query.length > 8);
  const start = candidateQueries.map((query) => layerText.indexOf(query)).find((index) => index >= 0);
  if (typeof start !== "number" || start < 0) return [];

  const queryLength = candidateQueries.find((query) => layerText.indexOf(query) === start)?.length ?? 0;
  const matchEnd = start + queryLength;
  const rangesBySpan = new Map<HTMLSpanElement, { start: number; end: number }>();

  for (let index = start; index < matchEnd; index += 1) {
    const position = searchIndex.positions[index];
    if (!position) continue;
    const existing = rangesBySpan.get(position.span);
    if (existing) {
      existing.start = Math.min(existing.start, position.offset);
      existing.end = Math.max(existing.end, position.offset + 1);
    } else {
      rangesBySpan.set(position.span, { start: position.offset, end: position.offset + 1 });
    }
  }

  const layerRect = highlightLayer.getBoundingClientRect();
  return Array.from(rangesBySpan.entries())
    .map(([span, range]) => spanRangeToLayerRect(span, range.start, range.end, layerRect))
    .map((rect) => ({
      left: Math.max(0, Math.min(layerRect.width, rect.left)),
      top: Math.max(0, Math.min(layerRect.height, rect.top)),
      width: Math.max(0, Math.min(layerRect.width - Math.max(0, rect.left), rect.width)),
      height: Math.max(0, Math.min(layerRect.height - Math.max(0, rect.top), rect.height))
    }))
    .filter((rect) => rect.width > 0 && rect.height > 0);
}

function buildTextLayerSearchIndex(textLayer: HTMLDivElement, separateSpans: boolean) {
  const spans = Array.from(textLayer.querySelectorAll("span"));
  const chars: string[] = [];
  const positions: ({ span: HTMLSpanElement; offset: number } | null)[] = [];

  const appendNormalizedCharacter = (character: string, position: { span: HTMLSpanElement; offset: number } | null) => {
    if (/\s/.test(character)) {
      if (chars.length > 0 && chars[chars.length - 1] !== " ") {
        chars.push(" ");
        positions.push(position);
      }
      return;
    }

    chars.push(character);
    positions.push(position);
  };

  spans.forEach((span, spanIndex) => {
    const text = span.textContent ?? "";
    for (let offset = 0; offset < text.length; offset += 1) {
      appendNormalizedCharacter(text[offset], { span, offset });
    }
    if (separateSpans && spanIndex < spans.length - 1) {
      appendNormalizedCharacter(" ", null);
    }
  });

  while (chars[chars.length - 1] === " ") {
    chars.pop();
    positions.pop();
  }

  return {
    text: chars.join(""),
    positions
  };
}

function findSearchMatchLocation(
  searchIndex: ReturnType<typeof buildTextLayerSearchIndex>,
  normalizedQuery: string,
  preferredStart: number,
  ordinal: number
) {
  const lowerText = searchIndex.text.toLowerCase();
  if (lowerText.slice(preferredStart, preferredStart + normalizedQuery.length) === normalizedQuery) {
    return { searchIndex, start: preferredStart };
  }

  const ordinalStart = findNthOccurrence(lowerText, normalizedQuery, ordinal);
  if (ordinalStart >= 0) {
    return { searchIndex, start: ordinalStart };
  }

  const firstStart = lowerText.indexOf(normalizedQuery);
  return firstStart >= 0 ? { searchIndex, start: firstStart } : null;
}

function findNthOccurrence(text: string, query: string, ordinal: number) {
  let index = -1;
  let fromIndex = 0;

  for (let count = 0; count <= ordinal; count += 1) {
    index = text.indexOf(query, fromIndex);
    if (index < 0) return -1;
    fromIndex = index + query.length;
  }

  return index;
}

function spanRangeToLayerRect(span: HTMLSpanElement, start: number, end: number, layerRect: DOMRect) {
  const text = span.textContent ?? "";
  const rect = span.getBoundingClientRect();
  const clampedStart = Math.max(0, Math.min(start, text.length));
  const clampedEnd = Math.max(clampedStart, Math.min(end, text.length));
  const selectedLength = Math.max(1, clampedEnd - clampedStart);
  const textLength = Math.max(1, text.length);
  const leftPadding = spanMatchesWholeText(clampedStart, clampedEnd, text.length)
    ? 0
    : rect.width * (clampedStart / textLength);
  const width = spanMatchesWholeText(clampedStart, clampedEnd, text.length)
    ? rect.width
    : rect.width * (selectedLength / textLength);

  return {
    left: rect.left - layerRect.left + leftPadding,
    top: rect.top - layerRect.top,
    width: Math.max(2, width),
    height: Math.max(2, rect.height)
  };
}

function spanMatchesWholeText(start: number, end: number, textLength: number) {
  return start <= 0 && end >= textLength;
}

function scrollSearchMarkerIntoDocumentPane(marker: Element) {
  const documentPane = marker.closest(".document-scroll");
  if (!(documentPane instanceof HTMLElement)) return;

  const markerRect = marker.getBoundingClientRect();
  const paneRect = documentPane.getBoundingClientRect();
  const outsideVertically = markerRect.top < paneRect.top || markerRect.bottom > paneRect.bottom;
  const outsideHorizontally = markerRect.left < paneRect.left || markerRect.right > paneRect.right;
  if (!outsideVertically && !outsideHorizontally) return;

  const markerCenterY = markerRect.top - paneRect.top + documentPane.scrollTop + markerRect.height / 2;
  const markerCenterX = markerRect.left - paneRect.left + documentPane.scrollLeft + markerRect.width / 2;
  documentPane.scrollTo({
    top: Math.max(0, markerCenterY - documentPane.clientHeight / 2),
    left: Math.max(0, markerCenterX - documentPane.clientWidth / 2),
    behavior: "smooth"
  });
}

function appendOcrTextLayer(container: HTMLDivElement, ocrPage: OcrPageText | null, zoom: number) {
  const nativeText = Array.from(container.querySelectorAll("span"))
    .map((span) => span.textContent ?? "")
    .join("")
    .trim();

  if (!ocrPage || nativeText.length > 0) return;

  for (const line of ocrPage.lines) {
    const span = document.createElement("span");
    span.textContent = line.text;
    span.style.left = `${line.x * zoom}px`;
    span.style.top = `${line.y * zoom}px`;
    span.style.width = `${line.width * zoom}px`;
    span.style.height = `${line.height * zoom}px`;
    span.style.fontSize = `${Math.max(6, line.height * zoom * 0.82)}px`;
    span.style.lineHeight = `${Math.max(6, line.height * zoom)}px`;
    span.style.display = "inline-block";
    span.dataset.ocr = "true";
    container.appendChild(span);
  }
}

function OverlayBox({
  overlay,
  zoom,
  selected,
  onSelect,
  onDeselect,
  onUpdate,
  onDelete
}: {
  overlay: OverlayItem;
  zoom: number;
  selected: boolean;
  onSelect: () => void;
  onDeselect: () => void;
  onUpdate: (patch: Partial<OverlayItem>, recordHistory?: boolean) => void;
  onDelete: () => void;
}) {
  const dragRef = useRef<{ startX: number; startY: number; originalX: number; originalY: number } | null>(null);

  return (
    <div
      className={`overlay-box ${overlay.kind} ${overlay.minimized ? "minimized" : ""} ${selected ? "selected" : ""}`}
      style={{
        left: overlay.x * zoom,
        top: overlay.y * zoom,
        width: overlay.width * zoom,
        height: overlay.height * zoom,
        color: overlay.color
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect();
        dragRef.current = { startX: event.clientX, startY: event.clientY, originalX: overlay.x, originalY: overlay.y };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!dragRef.current) return;
        onUpdate({
          x: Math.max(0, dragRef.current.originalX + (event.clientX - dragRef.current.startX) / zoom),
          y: Math.max(0, dragRef.current.originalY + (event.clientY - dragRef.current.startY) / zoom)
        }, false);
      }}
      onPointerUp={() => {
        dragRef.current = null;
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={() => {
        if (overlay.kind === "highlight" || overlay.dataUrl || overlay.minimized) return;
        const nextText = window.prompt("Edit text", overlay.text ?? "");
        if (nextText !== null) onUpdate({ text: nextText }, true);
      }}
    >
      {overlay.kind === "comment" && overlay.minimized ? (
        <>
          <button
            className="comment-pin"
            title="Open comment"
            style={{ left: -(overlay.x * zoom + 34) }}
            onPointerDown={(event) => {
              event.stopPropagation();
              onSelect();
            }}
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
          >
            <MessageSquarePlus size={15} />
          </button>
          {selected && (
            <div
              className="comment-popup"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <textarea
                autoFocus
                placeholder="Add comment"
                value={overlay.text ?? ""}
                onChange={(event) => onUpdate({ text: event.target.value }, true)}
              />
              <div className="comment-popup-actions">
                <button type="button" onClick={onDeselect}>
                  Minimize
                </button>
                <button type="button" onClick={onDelete}>
                  Delete
                </button>
              </div>
            </div>
          )}
        </>
      ) : overlay.kind === "signature" && overlay.dataUrl ? (
        <img src={overlay.dataUrl} alt="Signature" />
      ) : (
        <span style={{ fontSize: (overlay.fontSize ?? 14) * zoom }}>{overlay.text}</span>
      )}
      {selected && (
        <>
          <button className="delete-handle" title="Delete" onPointerDown={(event) => event.stopPropagation()} onClick={onDelete}>
            <X size={12} />
          </button>
          {!overlay.minimized && (
            <button
              className="resize-handle"
              title="Resize"
              onPointerDown={(event) => {
                event.stopPropagation();
                const startX = event.clientX;
                const startY = event.clientY;
                const startWidth = overlay.width;
                const startHeight = overlay.height;
                const target = event.currentTarget;
                target.setPointerCapture(event.pointerId);
                target.onpointermove = (moveEvent) => {
                  onUpdate({
                    width: Math.max(24, startWidth + (moveEvent.clientX - startX) / zoom),
                    height: Math.max(18, startHeight + (moveEvent.clientY - startY) / zoom)
                  }, false);
                };
                target.onpointerup = () => {
                  target.onpointermove = null;
                  target.onpointerup = null;
                };
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

function PageThumbnail({
  pdfDoc,
  pageNumber,
  active
}: {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  active: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;

    async function renderThumbnail() {
      const page = await pdfDoc.getPage(pageNumber);
      if (cancelled || !canvasRef.current) return;
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = 116 / baseViewport.width;
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderTask = page.render({ canvas, canvasContext: context, viewport });
      await renderTask.promise.catch(() => undefined);
    }

    void renderThumbnail();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDoc, pageNumber]);

  return <canvas className={active ? "active" : ""} ref={canvasRef} />;
}

function OutlineList({
  items,
  onSelectPage
}: {
  items: PdfTab["outline"];
  onSelectPage: (page: number) => void;
}) {
  return (
    <div className="outline-list">
      {items.map((item) => (
        <div className="outline-item" key={item.id}>
          <button disabled={!item.page} onClick={() => item.page && onSelectPage(item.page)} title={item.title}>
            <span>{item.title}</span>
            {item.page && <small>{item.page}</small>}
          </button>
          {item.children.length > 0 && <OutlineList items={item.children} onSelectPage={onSelectPage} />}
        </div>
      ))}
    </div>
  );
}

function Sidebar({
  mode,
  tab,
  selectedOverlay,
  signatureText,
  signatureFont,
  savedSignatures,
  selectedSignatureId,
  onSelectPage,
  onUpdateOverlay,
  onDeleteOverlay,
  onUpdateFormField,
  onInsertPage,
  onDeletePage,
  onMovePage,
  onReorderPage,
  onSignatureText,
  onSignatureFont,
  onSaveTypedSignature,
  onSelectSignature,
  onDeleteSignature,
  onSaveSignatureAsset,
  onOpenDrawingSignature,
  onSelectSemanticResult,
  onModeChange
}: {
  mode: SidebarMode;
  tab: PdfTab | null;
  selectedOverlay: OverlayItem | null;
  signatureText: string;
  signatureFont: string;
  savedSignatures: SignatureAsset[];
  selectedSignatureId: string | null;
  onSelectPage: (page: number) => void;
  onUpdateOverlay: (id: string, patch: Partial<OverlayItem>) => void;
  onDeleteOverlay: (id: string) => void;
  onUpdateFormField: (name: string, value: string | boolean) => void;
  onInsertPage: () => void;
  onDeletePage: () => void;
  onMovePage: (direction: -1 | 1) => void;
  onReorderPage: (fromPage: number, toPage: number) => void;
  onSignatureText: (value: string) => void;
  onSignatureFont: (value: string) => void;
  onSaveTypedSignature: () => void;
  onSelectSignature: (id: string) => void;
  onDeleteSignature: (id: string) => void;
  onSaveSignatureAsset: (asset: SignatureAsset) => void;
  onOpenDrawingSignature: () => void;
  onSelectSemanticResult: (result: PdfTab["semanticResults"][number]) => void;
  onModeChange: (mode: SidebarMode | null) => void;
}) {
  const typedInitials = initialsFromName(signatureText) || "AB";

  return (
    <aside className={`sidebar ${mode === "semantic" ? "right" : ""}`}>
      {(mode === "pages" || mode === "outline") && (
        <div className="sidebar-switch">
          <button className={mode === "pages" ? "active" : ""} onClick={() => onModeChange("pages")}>
            <PanelLeft size={15} />
            Pages
          </button>
          <button className={mode === "outline" ? "active" : ""} onClick={() => onModeChange("outline")}>
            <BookOpen size={15} />
            Bookmarks
          </button>
        </div>
      )}

      {mode === "semantic" && (
        <div className="semantic-sidebar">
          <div className="sidebar-section-heading">
            <Search size={15} />
            <h2>Semantic Search</h2>
          </div>
          {!tab?.searchQuery ? (
            <p>Search the document to find related passages.</p>
          ) : tab.semanticIndexStatus !== "ready" ? (
            <p>{tab.semanticIndexProgress?.message ?? "Preparing semantic index."}</p>
          ) : tab.semanticResults.length === 0 ? (
            <p>No related passages found.</p>
          ) : (
            <div className="semantic-result-list">
              {tab.semanticResults.map((result) => (
                <button
                  className={`semantic-result ${tab.semanticHighlight?.id === result.id ? "active" : ""}`}
                  key={result.id}
                  onClick={() => onSelectSemanticResult(result)}
                >
                  <span className="semantic-result-meta">
                    <span>Page {result.page}</span>
                    <span className="semantic-result-score">{result.score.toFixed(2)}</span>
                  </span>
                  <p>{result.snippet}</p>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {mode === "pages" && (
        <>
          {tab && (
            <div className="page-actions">
              <button title="Insert blank page after current page" onClick={onInsertPage}>
                <FilePlus2 size={15} />
                Insert
              </button>
              <button title="Move page up" disabled={tab.currentPage <= 1} onClick={() => onMovePage(-1)}>
                <ArrowUp size={15} />
              </button>
              <button title="Move page down" disabled={tab.currentPage >= tab.pageCount} onClick={() => onMovePage(1)}>
                <ArrowDown size={15} />
              </button>
              <button title="Delete current page" disabled={tab.pageCount <= 1} onClick={onDeletePage}>
                <Trash2 size={15} />
              </button>
            </div>
          )}
          <div className="page-list">
            {tab ? (
              Array.from({ length: tab.pageCount }, (_, index) => index + 1).map((page) => (
                <button
                  key={page}
                  className={page === tab.currentPage ? "active" : ""}
                  draggable
                  onClick={() => onSelectPage(page)}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", String(page));
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const fromPage = Number(event.dataTransfer.getData("text/plain"));
                    if (Number.isFinite(fromPage)) onReorderPage(fromPage, page);
                  }}
                >
                  <span className="drag-handle" title="Drag to reorder">
                    <GripVertical size={13} />
                  </span>
                  <PageThumbnail pdfDoc={tab.pdfDoc} pageNumber={page} active={page === tab.currentPage} />
                  <span>{page}</span>
                </button>
              ))
            ) : null}
          </div>
        </>
      )}

      {mode === "outline" && (
        <>
          {tab?.outline.length ? (
            <OutlineList items={tab.outline} onSelectPage={onSelectPage} />
          ) : (
            <p>No bookmarks found.</p>
          )}
        </>
      )}

      {mode === "comments" && (
        <>
          <h2>Comments</h2>
          {tab?.overlays.filter((overlay) => overlay.kind === "comment").length ? (
            <div className="stack">
              {tab.overlays
                .filter((overlay) => overlay.kind === "comment")
                .map((overlay) => (
                  <button key={overlay.id} className="comment-row" onClick={() => onSelectPage(overlay.page)}>
                    <strong>Page {overlay.page}</strong>
                    <span>{overlay.text}</span>
                  </button>
                ))}
            </div>
          ) : (
            <p>No comments yet.</p>
          )}
        </>
      )}

      {mode === "forms" && (
        <>
          <h2>Form Fields</h2>
          {tab?.formFields.length ? (
            <div className="stack">
              {tab.formFields.map((field) => (
                <label className="field-row" key={field.name}>
                  <span>{field.name}</span>
                  {field.kind === "checkbox" ? (
                    <input
                      type="checkbox"
                      checked={Boolean(field.value)}
                      onChange={(event) => onUpdateFormField(field.name, event.target.checked)}
                    />
                  ) : field.kind === "dropdown" || field.kind === "radio" ? (
                    <select value={String(field.value)} onChange={(event) => onUpdateFormField(field.name, event.target.value)}>
                      <option value="">Select</option>
                      {field.options?.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={String(field.value)}
                      onChange={(event) => onUpdateFormField(field.name, event.target.value)}
                    />
                  )}
                </label>
              ))}
            </div>
          ) : (
            <p>No fillable fields detected.</p>
          )}
        </>
      )}

      {mode === "signature" && (
        <>
          <h2>Signature</h2>
          <div className="signature-section">
            <label className="field-row">
              <span>Name and surname</span>
              <input
                placeholder="Type your name"
                value={signatureText}
                onChange={(event) => onSignatureText(event.target.value)}
              />
            </label>
            <label className="field-row">
              <span>Style</span>
              <select value={signatureFont} onChange={(event) => onSignatureFont(event.target.value)}>
                {signatureFonts.map((font) => (
                  <option key={font.family} value={font.family}>
                    {font.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="signature-preview-grid">
              <div className="signature-preview">
                <span style={{ fontFamily: signatureFont }}>{signatureText.trim() || "Signature"}</span>
              </div>
              <div className="signature-preview small">
                <span style={{ fontFamily: signatureFont }}>{typedInitials}</span>
              </div>
            </div>
            <button className="primary-button" onClick={onSaveTypedSignature}>
              <Check size={15} />
              Save typed set
            </button>
          </div>

          <div className="signature-section">
            <button className="secondary-button" onClick={onOpenDrawingSignature}>
              <PenLine size={15} />
              Draw signature
            </button>
            <label className="signature-upload">
              <FileText size={15} />
              Upload image
              <input
                type="file"
                accept="image/png,image/jpeg"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  const input = event.currentTarget;
                  const reader = new FileReader();
                  reader.onload = () => {
                    onSaveSignatureAsset({
                      id: newId("signature-image"),
                      kind: "image",
                      label: file.name,
                      dataUrl: String(reader.result),
                      width: 220,
                      height: 80,
                      createdAt: new Date().toISOString()
                    });
                    input.value = "";
                  };
                  reader.readAsDataURL(file);
                }}
              />
            </label>
          </div>

          <div className="signature-section">
            <h3>Saved</h3>
            {savedSignatures.length ? (
              <div className="signature-assets">
                {savedSignatures.map((asset) => (
                  <div
                    key={asset.id}
                    className={`signature-asset ${asset.id === selectedSignatureId ? "active" : ""}`}
                  >
                    <button className="signature-asset-select" onClick={() => onSelectSignature(asset.id)} title={asset.label}>
                      <img src={asset.dataUrl} alt={asset.label} />
                      <span>{asset.kind === "typed-initials" ? "Initials" : asset.kind === "date" ? "Date" : asset.label}</span>
                    </button>
                    <button
                      className="signature-asset-delete"
                      title="Delete saved signature"
                      onClick={() => onDeleteSignature(asset.id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p>No saved signatures.</p>
            )}
          </div>

          <p>Select a saved signature, initials, or date, then click a page to place it.</p>
        </>
      )}

      {selectedOverlay && (
        <div className="inspector">
          <h2>Selection</h2>
          {selectedOverlay.kind !== "highlight" && (
            <label className="field-row">
              <span>Text</span>
              <textarea
                value={selectedOverlay.text ?? ""}
                onChange={(event) => onUpdateOverlay(selectedOverlay.id, { text: event.target.value })}
              />
            </label>
          )}
          {(selectedOverlay.kind === "text" || selectedOverlay.kind === "signature") && (
            <label className="field-row">
              <span>Font size</span>
              <input
                type="number"
                min="8"
                max="96"
                value={selectedOverlay.fontSize ?? 16}
                onChange={(event) => onUpdateOverlay(selectedOverlay.id, { fontSize: Number(event.target.value) })}
              />
            </label>
          )}
          {selectedOverlay.kind === "text" && (
            <label className="field-row">
              <span>Color</span>
              <input
                type="color"
                value={selectedOverlay.color ?? defaultTextColor}
                onChange={(event) => onUpdateOverlay(selectedOverlay.id, { color: event.target.value })}
              />
            </label>
          )}
          <button className="danger-button" onClick={() => onDeleteOverlay(selectedOverlay.id)}>
            Delete selection
          </button>
        </div>
      )}
    </aside>
  );
}

function DrawingSignatureModal({
  onSave,
  onCancel
}: {
  onSave: (dataUrl: string, width: number, height: number) => void;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const hasDrawingRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.strokeStyle = "#111827";
    context.lineWidth = 3;
    context.lineCap = "round";
    context.lineJoin = "round";
  }, []);

  const clear = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "#111827";
    context.lineWidth = 3;
    context.lineCap = "round";
    context.lineJoin = "round";
    hasDrawingRef.current = false;
  };

  const pointForEvent = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * event.currentTarget.width,
      y: ((event.clientY - rect.top) / rect.height) * event.currentTarget.height
    };
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="signature-draw-modal" role="dialog" aria-modal="true" aria-labelledby="draw-signature-title">
        <div className="modal-header">
          <h2 id="draw-signature-title">Draw signature</h2>
          <button className="icon-button" title="Close" onClick={onCancel}>
            <X size={16} />
          </button>
        </div>
        <canvas
          ref={canvasRef}
          width={960}
          height={360}
          onPointerDown={(event) => {
            const context = event.currentTarget.getContext("2d");
            if (!context) return;
            drawingRef.current = true;
            hasDrawingRef.current = true;
            const point = pointForEvent(event);
            context.beginPath();
            context.moveTo(point.x, point.y);
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (!drawingRef.current) return;
            const context = event.currentTarget.getContext("2d");
            if (!context) return;
            const point = pointForEvent(event);
            context.lineTo(point.x, point.y);
            context.stroke();
          }}
          onPointerUp={() => {
            drawingRef.current = false;
          }}
          onPointerCancel={() => {
            drawingRef.current = false;
          }}
        />
        <div className="modal-actions">
          <button className="secondary-button" onClick={clear}>
            Clear
          </button>
          <button className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="primary-button"
            onClick={() => {
              const canvas = canvasRef.current;
              if (!canvas || !hasDrawingRef.current) return;
              onSave(canvas.toDataURL("image/png"), 260, 98);
            }}
          >
            <Check size={15} />
            Save drawing
          </button>
        </div>
      </div>
    </div>
  );
}

function SignatureSavePrompt({
  name,
  onChoose
}: {
  name: string;
  onChoose: (choice: "editable" | "flattened" | "cancel") => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="save-signature-modal" role="dialog" aria-modal="true" aria-labelledby="save-signature-title">
        <div className="modal-header">
          <h2 id="save-signature-title">Save signed PDF</h2>
          <button className="icon-button" title="Cancel" onClick={() => onChoose("cancel")}>
            <X size={16} />
          </button>
        </div>
        <p>
          {name} contains placed signatures. Keep them editable in MarkPDF, or save a flattened copy where
          they cannot be moved.
        </p>
        <div className="modal-actions">
          <button className="secondary-button" onClick={() => onChoose("editable")}>
            Save editable
          </button>
          <button className="primary-button" onClick={() => onChoose("flattened")}>
            Save flattened copy
          </button>
        </div>
      </div>
    </div>
  );
}
