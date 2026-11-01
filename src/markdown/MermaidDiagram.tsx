import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { Download, Maximize2, Minimize2, ZoomIn, ZoomOut } from "lucide-react";
import type { ThemeMode } from "../types";
import {
  DIAGRAM_ZOOM_STEPS,
  diagramFileName,
  diagramZoomLabel,
  stepDiagramZoom,
  svgNaturalWidth,
} from "./mermaidView";

interface MermaidDiagramProps {
  source: string;
  theme: ThemeMode;
  /** The element an expanded diagram fills: the pane the document is shown in. */
  expandedHost?: HTMLElement | null;
  /** The document's file name. Names a downloaded diagram. */
  documentName?: string;
  /** The diagram's position among the document's diagrams, counted from 1. */
  diagramNumber?: number;
  /** Told when the diagram opens over the document pane and when it closes again. */
  onExpandedChange?: (expanded: boolean) => void;
}

type RenderState =
  | { kind: "rendering" }
  | { kind: "rendered" }
  | { kind: "error"; message: string };

interface RenderedDiagram {
  svg: SVGSVGElement;
  /** The chart's own width in CSS pixels, or null when the SVG does not state one. */
  naturalWidth: number | null;
}

/**
 * The values the stylesheet sizes a chart from. `--mermaid-zoom` multiplies the fitted width,
 * and `--mermaid-max-width` stops a small chart from growing past its own width times the zoom.
 */
interface CanvasStyle extends CSSProperties {
  "--mermaid-zoom": string;
  "--mermaid-max-width"?: string;
}

const MIN_ZOOM = DIAGRAM_ZOOM_STEPS[0];
const MAX_ZOOM = DIAGRAM_ZOOM_STEPS[DIAGRAM_ZOOM_STEPS.length - 1];
const SAVE_FAILED_MESSAGE = "Could not save the diagram.";

function isSvgElement(element: Element): element is SVGSVGElement {
  return (
    element.namespaceURI === "http://www.w3.org/2000/svg" &&
    element.localName === "svg"
  );
}

function parseRenderedSvg(svg: string) {
  const parsed = new DOMParser().parseFromString(svg, "text/html");
  const element = parsed.body.firstElementChild;
  if (parsed.body.childElementCount !== 1 || !element || !isSvgElement(element)) {
    throw new Error("Mermaid returned an invalid SVG document.");
  }
  return document.importNode(element, true);
}

function renderErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) {
    return `Could not render this Mermaid diagram. ${error.message}`;
  }
  return "Could not render this Mermaid diagram.";
}

function canvasStyle(zoom: number, naturalWidth: number | null): CanvasStyle {
  const style: CanvasStyle = { "--mermaid-zoom": String(zoom) };
  if (naturalWidth !== null) style["--mermaid-max-width"] = `${naturalWidth * zoom}px`;
  return style;
}

/**
 * The chart as a standalone SVG file.
 *
 * It is drawn at its own size rather than stretched to a page, and it keeps the background the
 * reader saw it on. A chart drawn for the dark theme has light text, which would be unreadable on
 * the white page most viewers give an SVG file.
 */
function svgDocument(svg: SVGSVGElement, background: string): string {
  const copy = svg.cloneNode(true);
  if (!(copy instanceof Element) || !isSvgElement(copy)) {
    throw new Error("The diagram could not be copied.");
  }
  copy.style.removeProperty("max-width");
  const box = copy.viewBox.baseVal;
  if (box && box.width > 0 && box.height > 0) {
    copy.setAttribute("width", String(box.width));
    copy.setAttribute("height", String(box.height));
  }
  if (background && background !== "rgba(0, 0, 0, 0)" && background !== "transparent") {
    copy.style.backgroundColor = background;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(copy)}`;
}

interface DiagramHeaderProps {
  zoom: number;
  ready: boolean;
  expanded: boolean;
  canDownload: boolean;
  saveError: string | null;
  toggleRef: Ref<HTMLButtonElement>;
  onZoom: (direction: 1 | -1) => void;
  onResetZoom: () => void;
  onDownload: () => void;
  onToggleExpanded: () => void;
}

function DiagramHeader({
  zoom,
  ready,
  expanded,
  canDownload,
  saveError,
  toggleRef,
  onZoom,
  onResetZoom,
  onDownload,
  onToggleExpanded,
}: DiagramHeaderProps) {
  return (
    <div className="markdown-mermaid-header" role="group" aria-label="Diagram controls">
      {saveError && (
        <span className="markdown-mermaid-save-error" role="alert">
          {saveError}
        </span>
      )}
      <div className="markdown-mermaid-actions">
        <button
          type="button"
          className="icon-button"
          title="Zoom out"
          aria-label="Shrink diagram"
          disabled={!ready || zoom <= MIN_ZOOM}
          onClick={() => onZoom(-1)}
        >
          <ZoomOut size={15} />
        </button>
        <button
          type="button"
          className="text-button markdown-mermaid-zoom-level"
          title="Reset zoom"
          aria-label="Reset diagram size"
          disabled={!ready}
          onClick={onResetZoom}
        >
          {diagramZoomLabel(zoom)}
        </button>
        <button
          type="button"
          className="icon-button"
          title="Zoom in"
          aria-label="Enlarge diagram"
          disabled={!ready || zoom >= MAX_ZOOM}
          onClick={() => onZoom(1)}
        >
          <ZoomIn size={15} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="Download as SVG"
          aria-label="Download diagram"
          disabled={!ready || !canDownload}
          onClick={onDownload}
        >
          <Download size={15} />
        </button>
        <button
          ref={toggleRef}
          type="button"
          className="icon-button"
          title={expanded ? "Exit full screen (Esc)" : "Full screen"}
          aria-label={expanded ? "Collapse diagram" : "Expand diagram"}
          disabled={!ready}
          onClick={onToggleExpanded}
        >
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      </div>
    </div>
  );
}

export function MermaidDiagram({
  source,
  theme,
  expandedHost,
  documentName,
  diagramNumber = 1,
  onExpandedChange,
}: MermaidDiagramProps) {
  const generatedId = useId();
  const renderId = `mermaid-${generatedId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  // Mermaid renders into the inline canvas and clears it first, so neither canvas has React
  // children. The chart stays in the inline canvas while it is expanded, so the document keeps
  // its height and the reader's place; the expanded canvas shows a copy.
  const inlineCanvasRef = useRef<HTMLDivElement | null>(null);
  const expandedCanvasRef = useRef<HTMLDivElement | null>(null);
  const expandButtonRef = useRef<HTMLButtonElement | null>(null);
  const collapseButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasExpanded = useRef(false);
  const [state, setState] = useState<RenderState>({ kind: "rendering" });
  const [diagram, setDiagram] = useState<RenderedDiagram | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [inlineZoom, setInlineZoom] = useState(1);
  const [expandedZoom, setExpandedZoom] = useState(1);
  const [saveError, setSaveError] = useState<string | null>(null);
  // The owner hears about a change in the same event that makes it, so the document it makes
  // inert is usable again by the time focus returns to it.
  const expandedRef = useRef(false);
  const onExpandedChangeRef = useRef(onExpandedChange);
  onExpandedChangeRef.current = onExpandedChange;
  expandedRef.current = expanded;

  const changeExpanded = (next: boolean) => {
    if (next) setExpandedZoom(1);
    setExpanded(next);
    onExpandedChangeRef.current?.(next);
  };

  useEffect(() => {
    const container = inlineCanvasRef.current;
    if (!container) return;

    let disposed = false;
    setState({ kind: "rendering" });
    setDiagram(null);
    container.replaceChildren();

    const renderDiagram = async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        if (disposed) return;

        mermaid.initialize({
          securityLevel: "strict",
          startOnLoad: false,
          theme: theme === "dark" ? "dark" : "default",
        });
        const result = await mermaid.render(renderId, source, container);
        if (disposed) return;

        const svg = parseRenderedSvg(result.svg);
        container.replaceChildren(svg);
        result.bindFunctions?.(container);
        setDiagram({
          svg,
          naturalWidth: svgNaturalWidth({
            maxWidth: svg.style.maxWidth,
            viewBox: svg.getAttribute("viewBox"),
            width: svg.getAttribute("width"),
          }),
        });
        setState({ kind: "rendered" });
      } catch (renderError: unknown) {
        if (disposed) return;
        container.replaceChildren();
        setExpanded(false);
        if (expandedRef.current) onExpandedChangeRef.current?.(false);
        setState({ kind: "error", message: renderErrorMessage(renderError) });
      }
    };

    // React effect cleanup ignores stale render results after the source or theme changes.
    void renderDiagram();

    return () => {
      disposed = true;
    };
  }, [renderId, source, theme]);

  // Copy the chart into the expanded canvas, before paint so it never flashes empty. The copy
  // keeps the chart's ids, so its own style rules and arrowheads still apply to it.
  useLayoutEffect(() => {
    const target = expandedCanvasRef.current;
    if (!expanded || !target) return;
    target.replaceChildren(...(diagram ? [diagram.svg.cloneNode(true)] : []));
  }, [diagram, expanded]);

  // A diagram that goes away while it is open, with its fence, gives the document back.
  useEffect(
    () => () => {
      if (expandedRef.current) onExpandedChangeRef.current?.(false);
    },
    [],
  );

  // Focus follows the chart: to the expanded view's own button, and back to the one that opened it.
  useEffect(() => {
    if (expanded) {
      collapseButtonRef.current?.focus({ preventScroll: true });
    } else if (wasExpanded.current) {
      expandButtonRef.current?.focus({ preventScroll: true });
    }
    wasExpanded.current = expanded;
  }, [expanded]);

  // Escape closes the expanded view. It listens on the window in the capture phase, because
  // focus is often on the document behind the chart after a click on the chart itself.
  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      changeExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [expanded]);

  const ready = state.kind === "rendered" && diagram !== null;
  const canDownload = window.pdfReader !== undefined;

  const toggleExpanded = () => changeExpanded(!expanded);

  const downloadDiagram = async () => {
    const bridge = window.pdfReader;
    if (!diagram || !bridge) return;
    const canvas = inlineCanvasRef.current;
    const background = canvas ? getComputedStyle(canvas).backgroundColor : "";
    try {
      await bridge.saveDiagramSvg(
        diagramFileName(documentName, diagramNumber),
        svgDocument(diagram.svg, background),
      );
      setSaveError(null);
    } catch {
      setSaveError(SAVE_FAILED_MESSAGE);
    }
  };

  const naturalWidth = diagram?.naturalWidth ?? null;
  const header = (zoom: number, setZoom: (zoom: number) => void, isExpanded: boolean) => (
    <DiagramHeader
      zoom={zoom}
      ready={ready}
      expanded={isExpanded}
      canDownload={canDownload}
      saveError={saveError}
      toggleRef={isExpanded ? collapseButtonRef : expandButtonRef}
      onZoom={(direction) => setZoom(stepDiagramZoom(zoom, direction))}
      onResetZoom={() => setZoom(1)}
      onDownload={() => void downloadDiagram()}
      onToggleExpanded={toggleExpanded}
    />
  );

  return (
    <>
      {state.kind === "error" && (
        <div className="markdown-mermaid-error">
          <p role="alert">{state.message}</p>
          <pre>
            <span className="markdown-code-language">Mermaid</span>
            <code>{source}</code>
          </pre>
        </div>
      )}
      <div
        className="markdown-mermaid-frame"
        hidden={state.kind === "error"}
        aria-hidden={expanded || undefined}
        inert={expanded}
      >
        {header(inlineZoom, setInlineZoom, false)}
        <div
          ref={inlineCanvasRef}
          className="markdown-mermaid"
          role="img"
          aria-label="Mermaid diagram"
          aria-busy={state.kind === "rendering"}
          style={canvasStyle(inlineZoom, naturalWidth)}
        />
      </div>
      {expanded &&
        createPortal(
          <div
            className="markdown-mermaid-expanded"
            role="dialog"
            aria-label="Expanded Mermaid diagram"
          >
            {header(expandedZoom, setExpandedZoom, true)}
            <div
              ref={expandedCanvasRef}
              className="markdown-mermaid"
              role="img"
              aria-label="Mermaid diagram"
              style={canvasStyle(expandedZoom, naturalWidth)}
            />
          </div>,
          expandedHost ?? document.body,
        )}
    </>
  );
}
