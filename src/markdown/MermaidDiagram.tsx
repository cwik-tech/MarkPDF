import { useEffect, useId, useRef, useState } from "react";
import type { ThemeMode } from "../types";

interface MermaidDiagramProps {
  source: string;
  theme: ThemeMode;
}

type RenderState =
  | { kind: "rendering" }
  | { kind: "rendered" }
  | { kind: "error"; message: string };

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

export function MermaidDiagram({ source, theme }: MermaidDiagramProps) {
  const generatedId = useId();
  const renderId = `mermaid-${generatedId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<RenderState>({ kind: "rendering" });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    setState({ kind: "rendering" });
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
        setState({ kind: "rendered" });
      } catch (renderError: unknown) {
        if (disposed) return;
        container.replaceChildren();
        setState({ kind: "error", message: renderErrorMessage(renderError) });
      }
    };

    // React effect cleanup ignores stale render results after the source or theme changes.
    void renderDiagram();

    return () => {
      disposed = true;
    };
  }, [renderId, source, theme]);

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
        ref={containerRef}
        className="markdown-mermaid"
        role="img"
        aria-label="Mermaid diagram"
        aria-busy={state.kind === "rendering"}
        hidden={state.kind === "error"}
      />
    </>
  );
}
