import { Fragment, type ReactNode } from "react";
import type { ThemeMode } from "../types";
import { MermaidDiagram } from "./MermaidDiagram";
import {
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

function cleanMarkdownUrl(url: string) {
  const trimmed = url.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
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
      case "link":
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
      default:
        return <Fragment key={index}>{splitBySearch(token.text, highlight)}</Fragment>;
    }
  });
}

export function MarkdownPreview({
  markdown,
  theme,
  searchQuery,
  activeMatchIndex,
  baseUrl,
}: MarkdownPreviewProps) {
  const blocks = parseMarkdown(markdown);
  const query = searchQuery?.trim();
  const highlight: HighlightRun | null = query
    ? { query, activeIndex: activeMatchIndex ?? -1, nextOrdinal: 0 }
    : null;

  return (
    <article className="markdown-preview">
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          const Heading = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
          return <Heading key={index}>{inlineMarkdown(block.text, highlight, baseUrl)}</Heading>;
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
