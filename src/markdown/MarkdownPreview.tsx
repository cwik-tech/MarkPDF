import { Fragment, useRef, type MouseEvent, type ReactNode } from "react";
import type { ThemeMode } from "../types";
import { MermaidDiagram } from "./MermaidDiagram";
import { anchorTargetId, headingAnchorIds } from "./headingAnchors";
import {
  cleanMarkdownUrl,
  isMermaidBlock,
  parseMarkdown,
  tokenizeInline,
  type TableAlignment,
} from "./markdownDocument";

interface MarkdownPreviewProps {
  markdown: string;
  theme: ThemeMode;
  searchQuery?: string;
  /** Position of the highlight to mark as current, counted from the top. */
  activeMatchIndex?: number;
  baseUrl?: string;
  /** Document scale; 1 is actual size. Scales the sheet, its text and its diagrams together. */
  zoom?: number;
}

// Highlights are numbered as they are rendered, so the counter is created once
// per render pass and handed down through the block and inline helpers.
interface HighlightRun {
  query: string;
  activeIndex: number;
  nextOrdinal: number;
}

function tableCellStyle(alignment?: TableAlignment) {
  return alignment ? { textAlign: alignment } : undefined;
}

function splitBySearch(text: string, highlight: HighlightRun | null): ReactNode[] {
  if (!highlight) return [text];

  const lowerText = text.toLocaleLowerCase();
  const lowerQuery = highlight.query.toLocaleLowerCase();
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (;;) {
    const index = lowerText.indexOf(lowerQuery, cursor);
    if (index === -1) break;
    if (index > cursor) nodes.push(text.slice(cursor, index));

    const ordinal = highlight.nextOrdinal;
    highlight.nextOrdinal += 1;
    const isActive = ordinal === highlight.activeIndex;

    nodes.push(
      <mark
        key={`match-${ordinal}`}
        className={isActive ? "active" : undefined}
        data-search-match={ordinal}
        data-active-search-match={isActive ? "true" : undefined}
      >
        {text.slice(index, index + highlight.query.length)}
      </mark>,
    );
    cursor = index + highlight.query.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes.length ? nodes : [text];
}

function resolveMarkdownUrl(url: string, baseUrl?: string) {
  const cleanedUrl = cleanMarkdownUrl(url);
  if (
    !baseUrl ||
    cleanedUrl.startsWith("#") ||
    cleanedUrl.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(cleanedUrl)
  ) {
    return cleanedUrl;
  }

  try {
    return new URL(cleanedUrl, baseUrl).href;
  } catch {
    return cleanedUrl;
  }
}

function inlineMarkdown(
  text: string,
  highlight: HighlightRun | null,
  baseUrl?: string,
): ReactNode[] {
  return tokenizeInline(text).map((token, index) => {
    switch (token.kind) {
      case "code":
        return <code key={index}>{splitBySearch(token.text, highlight)}</code>;
      case "bold":
        return <strong key={index}>{splitBySearch(token.text, highlight)}</strong>;
      case "italic":
        return <em key={index}>{splitBySearch(token.text, highlight)}</em>;
      case "image":
        return (
          <img
            key={index}
            src={resolveMarkdownUrl(token.url, baseUrl)}
            alt={token.alt}
            loading="lazy"
          />
        );
      case "link": {
        // A link to a heading of this document stays in it. It carries no `target`, because asking
        // for a new window is what a link out of the document does, and the preview is where this
        // one lands; the heading it names travels on the element for the one handler that scrolls.
        const anchor = anchorTargetId(token.url);
        if (anchor !== null) {
          return (
            <a key={index} href={`#${anchor}`} data-markdown-anchor={anchor}>
              {splitBySearch(token.text, highlight)}
            </a>
          );
        }
        return (
          <a
            key={index}
            href={resolveMarkdownUrl(token.url, baseUrl)}
            target="_blank"
            rel="noreferrer"
          >
            {splitBySearch(token.text, highlight)}
          </a>
        );
      }
      default:
        return <Fragment key={index}>{splitBySearch(token.text, highlight)}</Fragment>;
    }
  });
}

/** How much of the page is left above a heading a link arrived at, so it does not touch the edge. */
const HEADING_SCROLL_MARGIN = 16;

/**
 * Bring a heading a link named to the top of the pane the document scrolls in.
 *
 * The pane rather than the heading's own nearest scrolling ancestor: `scrollIntoView` would also
 * scroll whatever else happens to be scrollable around it, and the reader asked for one thing to
 * move. Falls back to the browser's own behaviour if the preview is not inside a pane, which is
 * what a test rendering the component on its own does.
 */
function scrollHeadingIntoView(heading: Element): void {
  const pane = heading.closest(".markdown-document-scroll");
  if (!(pane instanceof HTMLElement)) {
    heading.scrollIntoView({ block: "start" });
    return;
  }

  const headingRect = heading.getBoundingClientRect();
  const paneRect = pane.getBoundingClientRect();
  pane.scrollTo({
    top: pane.scrollTop + headingRect.top - paneRect.top - HEADING_SCROLL_MARGIN,
    behavior: "smooth",
  });
}

export function MarkdownPreview({
  markdown,
  theme,
  searchQuery,
  activeMatchIndex,
  baseUrl,
  zoom = 1,
}: MarkdownPreviewProps) {
  const blocks = parseMarkdown(markdown);
  const headingIds = headingAnchorIds(blocks);
  const query = searchQuery?.trim();
  const highlight: HighlightRun | null = query
    ? { query, activeIndex: activeMatchIndex ?? -1, nextOrdinal: 0 }
    : null;
  const previewRef = useRef<HTMLElement | null>(null);

  /**
   * One handler for every link to a heading, rather than one per link.
   *
   * A document's table of contents is as many links as it has sections, and each of them does the
   * same thing. The heading is looked for inside this preview: two documents open at once can name
   * a section the same way, and the reader means the one they are reading.
   */
  const followAnchor = (event: MouseEvent<HTMLElement>) => {
    // `Element`, not `HTMLElement`: `closest` is on every element, and a click can land on one that
    // is not HTML. Nothing the preview renders puts such an element inside a link today, and a guard
    // that is narrower than the lookup it protects is how a click stops being claimed later.
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest("a[data-markdown-anchor]");
    if (!(link instanceof HTMLElement)) return;
    const anchor = link.dataset.markdownAnchor;
    if (anchor === undefined || anchor.length === 0) return;

    // Claimed whether or not the heading is there. The address bar has nowhere to go in this
    // application, and a link to a heading the document does not have must not become a navigation.
    event.preventDefault();
    const heading = previewRef.current?.querySelector(`[id="${CSS.escape(anchor)}"]`);
    if (heading !== null && heading !== undefined) scrollHeadingIntoView(heading);
  };

  return (
    <article
      className="markdown-preview"
      ref={previewRef}
      onClick={followAnchor}
      style={{ zoom }}
    >
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          const Heading = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
          return (
            <Heading key={index} id={headingIds.get(index)}>
              {inlineMarkdown(block.text, highlight, baseUrl)}
            </Heading>
          );
        }

        if (block.kind === "paragraph") {
          return <p key={index}>{inlineMarkdown(block.text, highlight, baseUrl)}</p>;
        }

        if (block.kind === "blockquote") {
          return <blockquote key={index}>{inlineMarkdown(block.text, highlight, baseUrl)}</blockquote>;
        }

        if (block.kind === "code") {
          if (isMermaidBlock(block)) {
            return <MermaidDiagram key={index} source={block.text} theme={theme} />;
          }

          return (
            <pre key={index}>
              {block.language && <span className="markdown-code-language">{block.language}</span>}
              <code>{splitBySearch(block.text, highlight)}</code>
            </pre>
          );
        }

        if (block.kind === "hr") {
          return <hr key={index} />;
        }

        if (block.kind === "ul") {
          return (
            <ul key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{inlineMarkdown(item, highlight, baseUrl)}</li>
              ))}
            </ul>
          );
        }

        if (block.kind === "table") {
          return (
            <div className="markdown-table-scroll" key={index}>
              <table>
                <thead>
                  <tr>
                    {block.headers.map((header, columnIndex) => (
                      <th key={columnIndex} style={tableCellStyle(block.alignments[columnIndex])}>
                        {inlineMarkdown(header, highlight, baseUrl)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, columnIndex) => (
                        <td key={columnIndex} style={tableCellStyle(block.alignments[columnIndex])}>
                          {inlineMarkdown(cell, highlight, baseUrl)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        return (
          <ol key={index}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>{inlineMarkdown(item, highlight, baseUrl)}</li>
            ))}
          </ol>
        );
      })}
    </article>
  );
}
