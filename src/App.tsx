import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FilePlus2,
  FileText,
  Highlighter,
  MessageSquarePlus,
  Minus,
  Moon,
  MousePointer2,
  PanelLeft,
  PenLine,
  Plus,
  Printer,
  RotateCw,
  Save,
  Search,
  Settings2,
  Signature,
  Sun,
  Type,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { detectFormFields, exportPdfBytes, loadPdfDocument } from "./pdf/document";
import type { FitMode, FormFieldState, OverlayItem, PdfTab, ThemeMode, ToolMode, ViewMode } from "./types";

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
  const [sidebar, setSidebar] = useState<"pages" | "comments" | "forms" | "signature" | null>("pages");
  const [signatureText, setSignatureText] = useState("Signature");
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");
  const workspaceRef = useRef<HTMLDivElement | null>(null);

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
      const pdfDoc = await loadPdfDocument(bytes);
      const formFields = await detectFormFields(bytes);
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
        scrolling: true,
        overlays: [],
        formFields,
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
        const result = await window.pdfReader.readPdf(path);
        await addTabFromBytes(Uint8Array.from(result.bytes), result.name, result.path);
      }
    },
    [addTabFromBytes]
  );

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
      const bytes = new Uint8Array(await file.arrayBuffer());
      await addTabFromBytes(bytes, file.name);
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

    updateTab(activeTab.id, {
      path: written.path,
      name: written.name,
      bytes: nextBytes,
      pdfDoc,
      pageCount: pdfDoc.numPages,
      overlays: [],
      formFields,
      dirty: false
    });
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
      overlays: [...tab.overlays, overlay],
      dirty: true
    }));
    setSelectedOverlayId(overlay.id);
    setTool("select");
  };

  const updateOverlay = (overlayId: string, patch: Partial<OverlayItem>) => {
    if (!activeTab) return;
    updateTab(activeTab.id, (tab) => ({
      overlays: tab.overlays.map((overlay) => (overlay.id === overlayId ? { ...overlay, ...patch } : overlay)),
      dirty: true
    }));
  };

  const deleteOverlay = (overlayId: string) => {
    if (!activeTab) return;
    updateTab(activeTab.id, (tab) => ({
      overlays: tab.overlays.filter((overlay) => overlay.id !== overlayId),
      dirty: true
    }));
    setSelectedOverlayId(null);
  };

  const updateFormField = (fieldName: string, value: string | boolean) => {
    if (!activeTab) return;
    updateTab(activeTab.id, (tab) => ({
      formFields: tab.formFields.map((field) => (field.name === fieldName ? { ...field, value } : field)),
      dirty: true
    }));
  };

  const selectedOverlay = activeTab?.overlays.find((overlay) => overlay.id === selectedOverlayId) ?? null;

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
      />

      <div className="toolbar">
        <button className="icon-button" title="Pages" onClick={() => setSidebar(sidebar === "pages" ? null : "pages")}>
          <PanelLeft size={18} />
        </button>
        <div className="divider" />
        <ToolButton active={tool === "select"} title="Select" onClick={() => setTool("select")}>
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
        <FitMenu activeTab={activeTab} onFit={(mode) => void applyFitMode(mode)} />
        <ViewMenu
          activeTab={activeTab}
          onChange={(patch) => activeTab && updateTab(activeTab.id, patch)}
        />
        <div className="toolbar-spacer" />
        <div className="search-box">
          <Search size={15} />
          <input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Find text" />
        </div>
        <button className="icon-button" title="Forms" disabled={!activeTab} onClick={() => setSidebar("forms")}>
          <Settings2 size={18} />
        </button>
      </div>

      <main className="workspace">
        {sidebar && (
          <Sidebar
            mode={sidebar}
            tab={activeTab}
            selectedOverlay={selectedOverlay}
            signatureText={signatureText}
            signatureDataUrl={signatureDataUrl}
            onSelectPage={(page) => activeTab && updateTab(activeTab.id, { currentPage: page })}
            onUpdateOverlay={updateOverlay}
            onDeleteOverlay={deleteOverlay}
            onUpdateFormField={updateFormField}
            onSignatureText={setSignatureText}
            onSignatureDataUrl={setSignatureDataUrl}
          />
        )}

        <section className="document-stage" ref={workspaceRef}>
          {!activeTab ? (
            <EmptyState onOpen={openFromDialog} />
          ) : (
            <DocumentView
              tab={activeTab}
              selectedOverlayId={selectedOverlayId}
              onPageClick={addOverlay}
              onSelectOverlay={setSelectedOverlayId}
              onUpdateOverlay={updateOverlay}
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
  onToggleTheme
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
      <span>/ {tab?.pageCount ?? 0}</span>
    </div>
  );
}

function FitMenu({ activeTab, onFit }: { activeTab: PdfTab | null; onFit: (fitMode: FitMode) => void }) {
  return (
    <div className="menu-button">
      <button className="text-button" disabled={!activeTab}>
        {activeTab?.fitMode === "actual" ? "Actual size" : `Fit ${activeTab?.fitMode ?? "page"}`}
        <ChevronDown size={15} />
      </button>
      <div className="menu-popover">
        <button onClick={() => onFit("actual")}>Actual size</button>
        <button onClick={() => onFit("page")}>Fit to page</button>
        <button onClick={() => onFit("width")}>Fit to width</button>
        <button onClick={() => onFit("height")}>Fit height</button>
      </div>
    </div>
  );
}

function ViewMenu({
  activeTab,
  onChange
}: {
  activeTab: PdfTab | null;
  onChange: (patch: Partial<PdfTab>) => void;
}) {
  return (
    <div className="menu-button">
      <button className="text-button" disabled={!activeTab}>
        {activeTab?.viewMode === "two" ? "Two-page" : "Single-page"}
        <ChevronDown size={15} />
      </button>
      <div className="menu-popover">
        <button onClick={() => onChange({ viewMode: "single" })}>
          {activeTab?.viewMode === "single" && <Check size={14} />}
          Single-page view
        </button>
        <button onClick={() => onChange({ viewMode: "two" })}>
          {activeTab?.viewMode === "two" && <Check size={14} />}
          Two-page view
        </button>
        <button onClick={() => onChange({ scrolling: !activeTab?.scrolling })}>
          {activeTab?.scrolling && <Check size={14} />}
          Enable scrolling
        </button>
      </div>
    </div>
  );
}

function EmptyState({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="empty-state">
      <FileText size={48} />
      <h1>Open PDF Reader</h1>
      <p>Open or drop a PDF to start reading, annotating, filling, and signing.</p>
      <button className="primary-button" onClick={onOpen}>
        <FilePlus2 size={18} />
        Open PDF
      </button>
    </div>
  );
}

function DocumentView({
  tab,
  selectedOverlayId,
  onPageClick,
  onSelectOverlay,
  onUpdateOverlay
}: {
  tab: PdfTab;
  selectedOverlayId: string | null;
  onPageClick: (page: number, x: number, y: number) => void;
  onSelectOverlay: (id: string | null) => void;
  onUpdateOverlay: (id: string, patch: Partial<OverlayItem>) => void;
}) {
  const pages = tab.scrolling
    ? Array.from({ length: tab.pageCount }, (_, index) => index + 1)
    : tab.viewMode === "two" && tab.currentPage < tab.pageCount
      ? [tab.currentPage, tab.currentPage + 1]
      : [tab.currentPage];

  return (
    <div className={`document-scroll ${tab.viewMode === "two" && !tab.scrolling ? "two-up" : ""}`}>
      {pages.map((pageNumber) => (
        <PdfPage
          key={`${tab.id}-${pageNumber}-${tab.rotation}`}
          pdfDoc={tab.pdfDoc}
          pageNumber={pageNumber}
          zoom={tab.zoom}
          rotation={tab.rotation}
          overlays={tab.overlays.filter((overlay) => overlay.page === pageNumber)}
          selectedOverlayId={selectedOverlayId}
          onPageClick={(x, y) => onPageClick(pageNumber, x, y)}
          onSelectOverlay={onSelectOverlay}
          onUpdateOverlay={onUpdateOverlay}
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
  overlays,
  selectedOverlayId,
  onPageClick,
  onSelectOverlay,
  onUpdateOverlay
}: {
  pdfDoc: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  rotation: number;
  overlays: OverlayItem[];
  selectedOverlayId: string | null;
  onPageClick: (x: number, y: number) => void;
  onSelectOverlay: (id: string | null) => void;
  onUpdateOverlay: (id: string, patch: Partial<OverlayItem>) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;

    async function renderPage() {
      const page = await pdfDoc.getPage(pageNumber);
      if (cancelled || !canvasRef.current) return;
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
      setSize({ width: viewport.width, height: viewport.height });
      renderTask = page.render({ canvas, canvasContext: context, viewport });
      await renderTask.promise.catch(() => undefined);
    }

    void renderPage();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfDoc, pageNumber, rotation, zoom]);

  return (
    <div className="page-wrap">
      <div className="page-number-label">Page {pageNumber}</div>
      <div
        className="pdf-page"
        style={{ width: size.width, height: size.height }}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          onSelectOverlay(null);
          onPageClick((event.clientX - rect.left) / zoom, (event.clientY - rect.top) / zoom);
        }}
      >
        <canvas ref={canvasRef} />
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
  onUpdate: (patch: Partial<OverlayItem>) => void;
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
        });
      }}
      onPointerUp={() => {
        dragRef.current = null;
      }}
      onDoubleClick={() => {
        if (overlay.kind === "highlight" || overlay.dataUrl) return;
        const nextText = window.prompt("Edit text", overlay.text ?? "");
        if (nextText !== null) onUpdate({ text: nextText });
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
              });
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

function Sidebar({
  mode,
  tab,
  selectedOverlay,
  signatureText,
  signatureDataUrl,
  onSelectPage,
  onUpdateOverlay,
  onDeleteOverlay,
  onUpdateFormField,
  onSignatureText,
  onSignatureDataUrl
}: {
  mode: "pages" | "comments" | "forms" | "signature";
  tab: PdfTab | null;
  selectedOverlay: OverlayItem | null;
  signatureText: string;
  signatureDataUrl: string | null;
  onSelectPage: (page: number) => void;
  onUpdateOverlay: (id: string, patch: Partial<OverlayItem>) => void;
  onDeleteOverlay: (id: string) => void;
  onUpdateFormField: (name: string, value: string | boolean) => void;
  onSignatureText: (value: string) => void;
  onSignatureDataUrl: (value: string | null) => void;
}) {
  return (
    <aside className="sidebar">
      {mode === "pages" && (
        <>
          <h2>Pages</h2>
          <div className="page-list">
            {tab ? (
              Array.from({ length: tab.pageCount }, (_, index) => index + 1).map((page) => (
                <button
                  key={page}
                  className={page === tab.currentPage ? "active" : ""}
                  onClick={() => onSelectPage(page)}
                >
                  <span>{page}</span>
                </button>
              ))
            ) : (
              <p>No document open.</p>
            )}
          </div>
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
