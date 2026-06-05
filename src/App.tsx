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
  Highlighter,
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
  Signature,
  ScrollText,
  StretchHorizontal,
  StretchVertical,
  Sun,
  Trash2,
  Type,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  deletePdfPage,
  detectFormFields,
  extractOutline,
  exportPdfBytes,
  findTextMatches,
  insertBlankPageAfter,
  isPasswordError,
  loadPdfDocument,
  movePdfPage
} from "./pdf/document";
import type { FitMode, FormFieldState, OverlayItem, PdfTab, TabHistoryState, ThemeMode, ToolMode, ViewMode } from "./types";

const defaultTextColor = "#1f2937";

function newId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function getInitialTheme(): ThemeMode {
  const stored = localStorage.getItem("open-pdf-reader-theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App() {
  const [tabs, setTabs] = useState<PdfTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [tool, setTool] = useState<ToolMode>("select");
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState<"pages" | "outline" | "comments" | "forms" | "signature" | null>(null);
  const [signatureText, setSignatureText] = useState("Signature");
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const [recentFiles, setRecentFiles] = useState<string[]>([]);
  const [isFullScreen, setIsFullScreen] = useState(false);
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

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [activeTabId, tabs]
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("open-pdf-reader-theme", theme);
  }, [theme]);

  const updateTab = useCallback((tabId: string, patch: Partial<PdfTab> | ((tab: PdfTab) => Partial<PdfTab>)) => {
    setTabs((current) =>
      current.map((tab) => {
        if (tab.id !== tabId) return tab;
        const nextPatch = typeof patch === "function" ? patch(tab) : patch;
        return { ...tab, ...nextPatch };
      })
    );
  }, []);

  const addTabFromBytes = useCallback(
    async (bytes: Uint8Array, name: string, path?: string) => {
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
      const tab: PdfTab = {
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
        overlays: [],
        formFields,
        outline,
        searchQuery: "",
        searchMatches: [],
        activeSearchMatch: -1,
        undoStack: [],
        redoStack: [],
        dirty: false
      };

      setTabs((current) => [...current, tab]);
      setActiveTabId(tab.id);
    },
    []
  );

  const openPdfPaths = useCallback(
    async (paths: string[]) => {
      if (!window.pdfReader) return;
      for (const path of paths) {
        try {
          const result = await window.pdfReader.readPdf(path);
          await addTabFromBytes(Uint8Array.from(result.bytes), result.name, result.path);
        } catch (error) {
          window.alert(error instanceof Error ? error.message : `Could not open "${path}".`);
        }
      }
      setRecentFiles(await window.pdfReader.listRecentFiles());
    },
    [addTabFromBytes]
  );

  const loadRecentFiles = useCallback(async () => {
    if (!window.pdfReader) return;
    setRecentFiles(await window.pdfReader.listRecentFiles());
  }, []);

  useEffect(() => {
    void loadRecentFiles();
  }, [loadRecentFiles]);

  useEffect(() => {
    if (!window.pdfReader) return undefined;
    void window.pdfReader.isFullScreen().then(setIsFullScreen);
    return window.pdfReader.onFullScreenChange(setIsFullScreen);
  }, []);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!tabs.some((tab) => tab.dirty)) return;
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [tabs]);

  useEffect(() => {
    if (!window.pdfReader) return undefined;
    return window.pdfReader.onOpenFile((filePath) => void openPdfPaths([filePath]));
  }, [openPdfPaths]);

  const openFromDialog = async () => {
    if (!window.pdfReader) {
      window.alert("Desktop file dialogs are available in Electron. Drop a PDF here for browser preview.");
      return;
    }
    const paths = await window.pdfReader.openPdfDialog();
    if (paths.length > 0) {
      await openPdfPaths(paths);
    }
  };

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files).filter(
      (file) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
    );

    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await addTabFromBytes(bytes, file.name);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : `Could not open "${file.name}".`);
      }
    }
  };

  const closeTab = (tabId: string) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;

    if (tab.dirty && !window.confirm(`Close "${tab.name}" without saving changes?`)) {
      return;
    }

    setTabs((current) => current.filter((item) => item.id !== tabId));
    if (activeTabId === tabId) {
      const remaining = tabs.filter((item) => item.id !== tabId);
      setActiveTabId(remaining.at(-1)?.id ?? null);
    }
  };

  const applyFitMode = async (fitMode: FitMode) => {
    if (!activeTab || !workspaceRef.current) return;
    const page = await activeTab.pdfDoc.getPage(activeTab.currentPage);
    const viewport = page.getViewport({ scale: 1, rotation: activeTab.rotation });
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

    updateTab(activeTab.id, { fitMode, zoom: Number(zoom.toFixed(2)) });
  };

  const saveActiveTab = async (saveAs = false, flattenForms = false) => {
    if (!activeTab) return;
    const bytes = await exportPdfBytes(activeTab.bytes, activeTab.overlays, activeTab.formFields, flattenForms);
    let targetPath = activeTab.path;

    if (!window.pdfReader) {
      downloadBytes(bytes, activeTab.name);
      return;
    }

    if (!targetPath || saveAs) {
      const selectedPath = await window.pdfReader.savePdfDialog(activeTab.name);
      if (!selectedPath) return;
      targetPath = selectedPath;
    }

    const written = await window.pdfReader.writePdf(targetPath, Array.from(bytes));
    const nextBytes = Uint8Array.from(bytes);
    const pdfDoc = await loadPdfDocument(nextBytes);
    const formFields = flattenForms ? [] : await detectFormFields(nextBytes);
    const outline = await extractOutline(pdfDoc);

    updateTab(activeTab.id, {
      path: written.path,
      name: written.name,
      bytes: nextBytes,
      pdfDoc,
      pageCount: pdfDoc.numPages,
      overlays: [],
      formFields,
      outline,
      searchMatches: [],
      activeSearchMatch: -1,
      undoStack: [],
      redoStack: [],
      dirty: false
    });
    await loadRecentFiles();
  };

  const printActiveTab = async () => {
    if (!activeTab) return;
    const bytes = await exportPdfBytes(activeTab.bytes, activeTab.overlays, activeTab.formFields, false);
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
    if (!activeTab) return;

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
      overlay = {
        id: newId("signature"),
        kind: "signature",
        page,
        x,
        y,
        width: 220,
        height: 80,
        text: signatureText,
        fontSize: 28,
        dataUrl: signatureDataUrl ?? undefined
      };
    }

    if (!overlay) return;

    updateTab(activeTab.id, (tab) => ({
      ...pushHistory(tab),
      overlays: [...tab.overlays, overlay],
      dirty: true
    }));
    setSelectedOverlayId(overlay.id);
    setTool("select");
  };

  const updateOverlay = (overlayId: string, patch: Partial<OverlayItem>, recordHistory = true) => {
    if (!activeTab) return;
    updateTab(activeTab.id, (tab) => ({
      ...(recordHistory ? pushHistory(tab) : {}),
      overlays: tab.overlays.map((overlay) => (overlay.id === overlayId ? { ...overlay, ...patch } : overlay)),
      dirty: true
    }));
  };

  const addSelectionOverlay = (kind: "highlight" | "comment") => {
    if (!activeTab || !selectionAction) return;
    const overlay: OverlayItem = {
      id: newId(kind),
      kind,
      page: selectionAction.page,
      x: selectionAction.x,
      y: selectionAction.y,
      width: selectionAction.width,
      height: kind === "highlight" ? selectionAction.height : Math.max(72, selectionAction.height + 36),
      text: kind === "comment" ? selectionAction.text || "Comment" : undefined,
      fontSize: kind === "comment" ? 12 : undefined,
      color: kind === "comment" ? "#2f2400" : "#facc15"
    };

    updateTab(activeTab.id, (tab) => ({
      ...pushHistory(tab),
      overlays: [...tab.overlays, overlay],
      dirty: true
    }));
    setSelectedOverlayId(overlay.id);
    setSelectionAction(null);
  };

  const deleteOverlay = (overlayId: string) => {
    if (!activeTab) return;
    updateTab(activeTab.id, (tab) => ({
      ...pushHistory(tab),
      overlays: tab.overlays.filter((overlay) => overlay.id !== overlayId),
      dirty: true
    }));
    setSelectedOverlayId(null);
  };

  const updateFormField = (fieldName: string, value: string | boolean) => {
    if (!activeTab) return;
    updateTab(activeTab.id, (tab) => ({
      ...pushHistory(tab),
      formFields: tab.formFields.map((field) => (field.name === fieldName ? { ...field, value } : field)),
      dirty: true
    }));
  };

  const restoreHistoryState = async (tabId: string, state: TabHistoryState) => {
    const pdfDoc = await loadPdfDocument(state.bytes);
    updateTab(tabId, {
      bytes: state.bytes,
      pdfDoc,
      pageCount: pdfDoc.numPages,
      currentPage: Math.min(state.currentPage, pdfDoc.numPages),
      overlays: state.overlays,
      formFields: state.formFields,
      outline: state.outline,
      searchMatches: [],
      activeSearchMatch: -1,
      dirty: true
    });
  };

  const undoActiveTab = async () => {
    if (!activeTab || activeTab.undoStack.length === 0) return;
    const previous = activeTab.undoStack.at(-1);
    if (!previous) return;
    const redoState = snapshotTab(activeTab);
    updateTab(activeTab.id, {
      undoStack: activeTab.undoStack.slice(0, -1),
      redoStack: [...activeTab.redoStack, redoState].slice(-50)
    });
    await restoreHistoryState(activeTab.id, previous);
  };

  const redoActiveTab = async () => {
    if (!activeTab || activeTab.redoStack.length === 0) return;
    const next = activeTab.redoStack.at(-1);
    if (!next) return;
    const undoState = snapshotTab(activeTab);
    updateTab(activeTab.id, {
      undoStack: [...activeTab.undoStack, undoState].slice(-50),
      redoStack: activeTab.redoStack.slice(0, -1)
    });
    await restoreHistoryState(activeTab.id, next);
  };

  const replaceDocumentBytes = async (
    bytes: Uint8Array,
    page: number,
    updateOverlays: (overlays: OverlayItem[]) => OverlayItem[]
  ) => {
    if (!activeTab) return;
    const pdfDoc = await loadPdfDocument(bytes);
    const formFields = await detectFormFields(bytes);
    const outline = await extractOutline(pdfDoc);
    updateTab(activeTab.id, (tab) => ({
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
      dirty: true
    }));
  };

  const insertPageAfterCurrent = async () => {
    if (!activeTab) return;
    const bytes = await insertBlankPageAfter(activeTab.bytes, activeTab.currentPage);
    await replaceDocumentBytes(bytes, activeTab.currentPage + 1, (overlays) =>
      overlays.map((overlay) => (overlay.page > activeTab.currentPage ? { ...overlay, page: overlay.page + 1 } : overlay))
    );
  };

  const deleteCurrentPage = async () => {
    if (!activeTab || activeTab.pageCount <= 1) return;
    if (!window.confirm(`Delete page ${activeTab.currentPage}?`)) return;
    const deletedPage = activeTab.currentPage;
    const bytes = await deletePdfPage(activeTab.bytes, deletedPage);
    await replaceDocumentBytes(bytes, Math.min(deletedPage, activeTab.pageCount - 1), (overlays) =>
      overlays
        .filter((overlay) => overlay.page !== deletedPage)
        .map((overlay) => (overlay.page > deletedPage ? { ...overlay, page: overlay.page - 1 } : overlay))
    );
  };

  const moveCurrentPage = async (direction: -1 | 1) => {
    if (!activeTab) return;
    const fromPage = activeTab.currentPage;
    const toPage = fromPage + direction;
    if (toPage < 1 || toPage > activeTab.pageCount) return;
    const bytes = await movePdfPage(activeTab.bytes, fromPage, direction);
    await replaceDocumentBytes(bytes, toPage, (overlays) =>
      overlays.map((overlay) => {
        if (overlay.page === fromPage) return { ...overlay, page: toPage };
        if (direction === -1 && overlay.page === toPage) return { ...overlay, page: fromPage };
        if (direction === 1 && overlay.page === toPage) return { ...overlay, page: fromPage };
        return overlay;
      })
    );
  };

  const runSearch = async () => {
    if (!activeTab) return;
    const matches = await findTextMatches(activeTab.pdfDoc, searchText);
    const firstMatch = matches[0];
    updateTab(activeTab.id, {
      searchQuery: searchText,
      searchMatches: matches,
      activeSearchMatch: firstMatch ? 0 : -1,
      currentPage: firstMatch?.page ?? activeTab.currentPage
    });
  };

  const stepSearch = (direction: 1 | -1) => {
    if (!activeTab || activeTab.searchMatches.length === 0) return;
    const nextIndex =
      (activeTab.activeSearchMatch + direction + activeTab.searchMatches.length) % activeTab.searchMatches.length;
    updateTab(activeTab.id, {
      activeSearchMatch: nextIndex,
      currentPage: activeTab.searchMatches[nextIndex].page
    });
  };

  const selectedOverlay = activeTab?.overlays.find((overlay) => overlay.id === selectedOverlayId) ?? null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!activeTab) return;
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT";
      const shortcut = event.metaKey || event.ctrlKey;

      if (shortcut && event.key.toLowerCase() === "f") {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (shortcut && event.key.toLowerCase() === "z" && !event.shiftKey) {
        event.preventDefault();
        void undoActiveTab();
        return;
      }

      if (shortcut && (event.key.toLowerCase() === "y" || (event.key.toLowerCase() === "z" && event.shiftKey))) {
        event.preventDefault();
        void redoActiveTab();
        return;
      }

      if (shortcut && (event.key === "+" || event.key === "=")) {
        event.preventDefault();
        updateTab(activeTab.id, { zoom: Math.min(4, activeTab.zoom + 0.1), fitMode: "actual" });
        return;
      }

      if (shortcut && event.key === "-") {
        event.preventDefault();
        updateTab(activeTab.id, { zoom: Math.max(0.25, activeTab.zoom - 0.1), fitMode: "actual" });
        return;
      }

      if (shortcut && event.key === "0") {
        event.preventDefault();
        updateTab(activeTab.id, { zoom: 1, fitMode: "actual" });
        return;
      }

      if (isTyping) return;

      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        updateTab(activeTab.id, { currentPage: Math.max(1, activeTab.currentPage - 1) });
      }

      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        updateTab(activeTab.id, { currentPage: Math.min(activeTab.pageCount, activeTab.currentPage + 1) });
      }

      if (event.key === "Escape") {
        setTool("select");
        setSelectedOverlayId(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTab, updateTab]);

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
        onExportFlattened={() => void saveActiveTab(true, true)}
        onPrint={() => void printActiveTab()}
        theme={theme}
        onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
        isFullScreen={isFullScreen}
        onToggleFullScreen={() => void toggleFullScreen()}
        recentFiles={recentFiles}
        onOpenRecent={(path) => void openPdfPaths([path])}
        onClearRecent={async () => {
          if (!window.pdfReader) return;
          setRecentFiles(await window.pdfReader.clearRecentFiles());
        }}
      />

      <div className="toolbar">
        <button className="icon-button" title="Pages" onClick={() => setSidebar(sidebar === "pages" ? null : "pages")}>
          <PanelLeft size={18} />
        </button>
        <div className="divider" />
        <ToolButton active={tool === "select"} title="Select text" onClick={() => setTool("select")}>
          <MousePointer2 size={18} />
        </ToolButton>
        <ToolButton active={tool === "text"} title="Add text" onClick={() => setTool("text")}>
          <Type size={18} />
        </ToolButton>
        <ToolButton active={tool === "comment"} title="Add comment" onClick={() => setTool("comment")}>
          <MessageSquarePlus size={18} />
        </ToolButton>
        <ToolButton active={tool === "highlight"} title="Highlight" onClick={() => setTool("highlight")}>
          <Highlighter size={18} />
        </ToolButton>
        <ToolButton
          active={tool === "signature"}
          title="Sign"
          onClick={() => {
            setTool("signature");
            setSidebar("signature");
          }}
        >
          <Signature size={18} />
        </ToolButton>
        <div className="divider" />
        <button
          className="icon-button"
          title="Previous page"
          disabled={!activeTab || activeTab.currentPage <= 1}
          onClick={() => activeTab && updateTab(activeTab.id, { currentPage: activeTab.currentPage - 1 })}
        >
          <ChevronLeft size={18} />
        </button>
        <PageBox tab={activeTab} onChange={(page) => activeTab && updateTab(activeTab.id, { currentPage: page })} />
        <button
          className="icon-button"
          title="Next page"
          disabled={!activeTab || activeTab.currentPage >= activeTab.pageCount}
          onClick={() => activeTab && updateTab(activeTab.id, { currentPage: activeTab.currentPage + 1 })}
        >
          <ChevronRight size={18} />
        </button>
        <button
          className="icon-button"
          title="Rotate page view"
          disabled={!activeTab}
          onClick={() => activeTab && updateTab(activeTab.id, { rotation: (activeTab.rotation + 90) % 360 })}
        >
          <RotateCw size={18} />
        </button>
        <div className="divider" />
        <div className="zoom-control">
          <button
            className="icon-button"
            title="Zoom out"
            disabled={!activeTab}
            onClick={() => activeTab && updateTab(activeTab.id, { zoom: Math.max(0.25, activeTab.zoom - 0.1), fitMode: "actual" })}
          >
            <Minus size={18} />
          </button>
          <span className="zoom-label">{activeTab ? `${Math.round(activeTab.zoom * 100)}%` : "100%"}</span>
          <button
            className="icon-button"
            title="Zoom in"
            disabled={!activeTab}
            onClick={() => activeTab && updateTab(activeTab.id, { zoom: Math.min(4, activeTab.zoom + 0.1), fitMode: "actual" })}
          >
            <Plus size={18} />
          </button>
        </div>
        <FitMenu activeTab={activeTab} onFit={(mode) => void applyFitMode(mode)} />
        <ViewMenu
          activeTab={activeTab}
          onChange={(patch) => activeTab && updateTab(activeTab.id, patch)}
          isFullScreen={isFullScreen}
          onToggleFullScreen={() => void toggleFullScreen()}
        />
        <div className="toolbar-spacer" />
        <div
          className={`search-box ${searchText || activeTab?.searchQuery ? "active" : ""}`}
          onMouseEnter={() => searchInputRef.current?.focus()}
        >
          <Search size={15} />
          <input
            ref={searchInputRef}
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                if (event.shiftKey) stepSearch(-1);
                else if (activeTab?.searchQuery === searchText && activeTab.searchMatches.length > 0) stepSearch(1);
                else void runSearch();
              }
            }}
            placeholder="Find text"
          />
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
      </div>

      <main className="workspace">
        {sidebar && (
          <Sidebar
            mode={sidebar}
            tab={activeTab}
            selectedOverlay={selectedOverlay}
            signatureText={signatureText}
            signatureDataUrl={signatureDataUrl}
            recentFiles={recentFiles}
            onSelectPage={(page) => activeTab && updateTab(activeTab.id, { currentPage: page })}
            onOpenRecent={(path) => void openPdfPaths([path])}
            onUpdateOverlay={updateOverlay}
            onDeleteOverlay={deleteOverlay}
            onUpdateFormField={updateFormField}
            onInsertPage={() => void insertPageAfterCurrent()}
            onDeletePage={() => void deleteCurrentPage()}
            onMovePage={(direction) => void moveCurrentPage(direction)}
            onSignatureText={setSignatureText}
            onSignatureDataUrl={setSignatureDataUrl}
            onModeChange={setSidebar}
          />
        )}

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

        <section className="document-stage" ref={workspaceRef}>
          {!activeTab ? (
            <EmptyState onOpen={openFromDialog} recentFiles={recentFiles} onOpenRecent={(path) => void openPdfPaths([path])} />
          ) : (
            <DocumentView
              tab={activeTab}
              tool={tool}
              selectedOverlayId={selectedOverlayId}
              onPageClick={addOverlay}
              onSelectOverlay={setSelectedOverlayId}
              onUpdateOverlay={updateOverlay}
              onTextSelection={setSelectionAction}
              onWheelPage={(direction) => {
                const nextPage = Math.min(activeTab.pageCount, Math.max(1, activeTab.currentPage + direction));
                if (nextPage !== activeTab.currentPage) updateTab(activeTab.id, { currentPage: nextPage });
              }}
            />
          )}
        </section>
      </main>
    </div>
  );
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

function TopBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onOpen,
  onSave,
  onSaveAs,
  onExportFlattened,
  onPrint,
  theme,
  onToggleTheme,
  isFullScreen,
  onToggleFullScreen,
  recentFiles,
  onOpenRecent,
  onClearRecent
}: {
  tabs: PdfTab[];
  activeTabId: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onExportFlattened: () => void;
  onPrint: () => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
  isFullScreen: boolean;
  onToggleFullScreen: () => void;
  recentFiles: string[];
  onOpenRecent: (path: string) => void;
  onClearRecent: () => void;
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
            <X
              size={14}
              onClick={(event) => {
                event.stopPropagation();
                onCloseTab(tab.id);
              }}
            />
          </button>
        ))}
      </div>
      <div className="top-actions">
        <button className="text-button" onClick={onOpen}>
          <FilePlus2 size={16} />
          Open
        </button>
        <div className="menu-button">
          <button className="text-button" disabled={recentFiles.length === 0}>
            Recent
            <ChevronDown size={15} />
          </button>
          <div className="menu-popover right wide">
            {recentFiles.map((path) => (
              <button key={path} onClick={() => onOpenRecent(path)} title={path}>
                <span className="menu-title">{truncateMiddle(fileNameFromPath(path), 36)}</span>
              </button>
            ))}
            <button onClick={onClearRecent}>Clear recent files</button>
          </div>
        </div>
        <button className="icon-button" title="Save" onClick={onSave} disabled={tabs.length === 0}>
          <Save size={17} />
        </button>
        <div className="menu-button">
          <button className="icon-button" title="Save options" disabled={tabs.length === 0}>
            <ChevronDown size={17} />
          </button>
          <div className="menu-popover right">
            <button onClick={onSaveAs}>Save as</button>
            <button onClick={onExportFlattened}>Export flattened PDF</button>
          </div>
        </div>
        <button className="icon-button" title="Print" onClick={onPrint} disabled={tabs.length === 0}>
          <Printer size={17} />
        </button>
        <button className="icon-button" title="Toggle theme" onClick={onToggleTheme}>
          {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
        </button>
        <button className="icon-button" title={isFullScreen ? "Exit full screen" : "Full screen"} onClick={onToggleFullScreen}>
          {isFullScreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
        </button>
      </div>
    </header>
  );
}

function ToolButton({
  active,
  title,
  onClick,
  children
}: {
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button className={`icon-button ${active ? "active" : ""}`} title={title} onClick={onClick}>
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

function FitMenu({ activeTab, onFit }: { activeTab: PdfTab | null; onFit: (fitMode: FitMode) => void }) {
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
    <div className="menu-button">
      <button className="icon-button menu-trigger" title={activeMode === "actual" ? "Actual size" : `Fit ${activeMode}`} disabled={!activeTab}>
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
  onToggleFullScreen
}: {
  activeTab: PdfTab | null;
  onChange: (patch: Partial<PdfTab>) => void;
  isFullScreen: boolean;
  onToggleFullScreen: () => void;
}) {
  const activeViewIcon = activeTab?.viewMode === "two" ? <Columns2 size={18} /> : <FileText size={18} />;

  return (
    <div className="menu-button">
      <button className="icon-button menu-trigger" title={activeTab?.viewMode === "two" ? "Two-page view" : "Single-page view"} disabled={!activeTab}>
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
  onOpenRecent
}: {
  onOpen: () => void;
  recentFiles: string[];
  onOpenRecent: (path: string) => void;
}) {
  return (
    <div className="empty-state">
      <FileText size={48} />
      <h1>Open PDF Reader</h1>
      <p>Open or drop a PDF to start reading, annotating, filling, and signing.</p>
      <button className="primary-button" onClick={onOpen}>
        <FilePlus2 size={18} />
        Open PDF
      </button>
      {recentFiles.length > 0 && (
        <div className="recent-empty">
          <h2>Recent</h2>
          {recentFiles.slice(0, 5).map((path) => (
            <button key={path} onClick={() => onOpenRecent(path)} title={path}>
              {fileNameFromPath(path)}
            </button>
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

function DocumentView({
  tab,
  tool,
  selectedOverlayId,
  onPageClick,
  onSelectOverlay,
  onUpdateOverlay,
  onTextSelection,
  onWheelPage
}: {
  tab: PdfTab;
  tool: ToolMode;
  selectedOverlayId: string | null;
  onPageClick: (page: number, x: number, y: number) => void;
  onSelectOverlay: (id: string | null) => void;
  onUpdateOverlay: (id: string, patch: Partial<OverlayItem>, recordHistory?: boolean) => void;
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
  onWheelPage: (direction: -1 | 1) => void;
}) {
  const pages = tab.scrolling
    ? Array.from({ length: tab.pageCount }, (_, index) => index + 1)
    : tab.viewMode === "two" && tab.currentPage < tab.pageCount
      ? [tab.currentPage, tab.currentPage + 1]
      : [tab.currentPage];

  return (
    <div
      className={`document-scroll ${tab.viewMode === "two" && !tab.scrolling ? "two-up" : ""}`}
      onWheelCapture={(event) => {
        const target = event.currentTarget;
        const canScrollVertically = target.scrollHeight > target.clientHeight;
        const canScrollHorizontally = target.scrollWidth > target.clientWidth;
        if (!canScrollVertically && !canScrollHorizontally) return;
        const atTop = target.scrollTop <= 0;
        const atBottom = Math.ceil(target.scrollTop + target.clientHeight) >= target.scrollHeight;
        event.preventDefault();
        if (!tab.scrolling && event.deltaY < 0 && atTop) {
          onWheelPage(-1);
          return;
        }
        if (!tab.scrolling && event.deltaY > 0 && atBottom) {
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
          overlays={tab.overlays.filter((overlay) => overlay.page === pageNumber)}
          selectedOverlayId={selectedOverlayId}
          onPageClick={(x, y) => onPageClick(pageNumber, x, y)}
          onSelectOverlay={onSelectOverlay}
          onUpdateOverlay={onUpdateOverlay}
          onTextSelection={onTextSelection}
        />
      ))}
    </div>
  );
}

function PdfPage({
  pdfDoc,
  pageNumber,
  zoom,
  rotation,
  tool,
  overlays,
  selectedOverlayId,
  onPageClick,
  onSelectOverlay,
  onUpdateOverlay,
  onTextSelection
}: {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  rotation: number;
  tool: ToolMode;
  overlays: OverlayItem[];
  selectedOverlayId: string | null;
  onPageClick: (x: number, y: number) => void;
  onSelectOverlay: (id: string | null) => void;
  onUpdateOverlay: (id: string, patch: Partial<OverlayItem>) => void;
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
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [renderError, setRenderError] = useState<string | null>(null);

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
  }, [pdfDoc, pageNumber, rotation, zoom]);

  return (
    <div className="page-wrap">
      <div className="page-number-label">Page {pageNumber}</div>
      <div
        className={`pdf-page ${tool === "select" ? "selectable" : "editing"}`}
        style={{ width: size.width, height: size.height }}
        onMouseDown={() => onTextSelection(null)}
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
          onTextSelection({
            page: pageNumber,
            x: Math.max(0, (left - pageRect.left) / zoom),
            y: Math.max(0, (top - pageRect.top) / zoom),
            width: Math.max(12, (right - left) / zoom),
            height: Math.max(8, (bottom - top) / zoom),
            screenX: left + (right - left) / 2,
            screenY: Math.max(10, top - 10),
            text: selection.toString().trim()
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
          onUpdate={(patch) => onUpdateOverlay(overlay.id, patch)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function OverlayBox({
  overlay,
  zoom,
  selected,
  onSelect,
  onUpdate
}: {
  overlay: OverlayItem;
  zoom: number;
  selected: boolean;
  onSelect: () => void;
  onUpdate: (patch: Partial<OverlayItem>, recordHistory?: boolean) => void;
}) {
  const dragRef = useRef<{ startX: number; startY: number; originalX: number; originalY: number } | null>(null);

  return (
    <div
      className={`overlay-box ${overlay.kind} ${selected ? "selected" : ""}`}
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
        if (overlay.kind === "highlight" || overlay.dataUrl) return;
        const nextText = window.prompt("Edit text", overlay.text ?? "");
        if (nextText !== null) onUpdate({ text: nextText }, true);
      }}
    >
      {overlay.kind === "signature" && overlay.dataUrl ? (
        <img src={overlay.dataUrl} alt="Signature" />
      ) : (
        <span style={{ fontSize: (overlay.fontSize ?? 14) * zoom }}>{overlay.text}</span>
      )}
      {selected && (
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
  signatureDataUrl,
  recentFiles,
  onSelectPage,
  onOpenRecent,
  onUpdateOverlay,
  onDeleteOverlay,
  onUpdateFormField,
  onInsertPage,
  onDeletePage,
  onMovePage,
  onSignatureText,
  onSignatureDataUrl,
  onModeChange
}: {
  mode: "pages" | "outline" | "comments" | "forms" | "signature";
  tab: PdfTab | null;
  selectedOverlay: OverlayItem | null;
  signatureText: string;
  signatureDataUrl: string | null;
  recentFiles: string[];
  onSelectPage: (page: number) => void;
  onOpenRecent: (path: string) => void;
  onUpdateOverlay: (id: string, patch: Partial<OverlayItem>) => void;
  onDeleteOverlay: (id: string) => void;
  onUpdateFormField: (name: string, value: string | boolean) => void;
  onInsertPage: () => void;
  onDeletePage: () => void;
  onMovePage: (direction: -1 | 1) => void;
  onSignatureText: (value: string) => void;
  onSignatureDataUrl: (value: string | null) => void;
  onModeChange: (mode: "pages" | "outline" | "comments" | "forms" | "signature" | null) => void;
}) {
  return (
    <aside className="sidebar">
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
                  onClick={() => onSelectPage(page)}
                >
                  <PageThumbnail pdfDoc={tab.pdfDoc} pageNumber={page} active={page === tab.currentPage} />
                  <span>{page}</span>
                </button>
              ))
            ) : (
              <>
                <p>No document open.</p>
                {recentFiles.length > 0 && (
                  <div className="stack">
                    {recentFiles.slice(0, 6).map((path) => (
                      <button className="comment-row" key={path} onClick={() => onOpenRecent(path)} title={path}>
                        <strong>{fileNameFromPath(path)}</strong>
                        <span>{path}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
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
          <label className="field-row">
            <span>Typed signature</span>
            <input value={signatureText} onChange={(event) => onSignatureText(event.target.value)} />
          </label>
          <SignaturePad onChange={onSignatureDataUrl} />
          <label className="upload-row">
            Upload image
            <input
              type="file"
              accept="image/png,image/jpeg"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => onSignatureDataUrl(String(reader.result));
                reader.readAsDataURL(file);
              }}
            />
          </label>
          {signatureDataUrl && (
            <button className="secondary-button" onClick={() => onSignatureDataUrl(null)}>
              Clear image
            </button>
          )}
          <p>Choose the signature tool, then click a page to place it.</p>
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

function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = "#111827";
    context.lineWidth = 2.4;
    context.lineCap = "round";
  }, []);

  const update = () => {
    const canvas = canvasRef.current;
    if (canvas) onChange(canvas.toDataURL("image/png"));
  };

  return (
    <div className="signature-pad">
      <canvas
        ref={canvasRef}
        width={420}
        height={160}
        onPointerDown={(event) => {
          const context = event.currentTarget.getContext("2d");
          if (!context) return;
          drawingRef.current = true;
          const rect = event.currentTarget.getBoundingClientRect();
          context.beginPath();
          context.moveTo(event.clientX - rect.left, event.clientY - rect.top);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drawingRef.current) return;
          const context = event.currentTarget.getContext("2d");
          if (!context) return;
          const rect = event.currentTarget.getBoundingClientRect();
          context.lineTo(event.clientX - rect.left, event.clientY - rect.top);
          context.stroke();
          update();
        }}
        onPointerUp={() => {
          drawingRef.current = false;
          update();
        }}
      />
      <button
        className="secondary-button"
        onClick={() => {
          const canvas = canvasRef.current;
          const context = canvas?.getContext("2d");
          if (!canvas || !context) return;
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.strokeStyle = "#111827";
          context.lineWidth = 2.4;
          context.lineCap = "round";
          onChange(null);
        }}
      >
        Clear drawing
      </button>
    </div>
  );
}
