import { Fragment, type ReactNode } from "react";

interface MarkdownPreviewProps {
  markdown: string;
  searchQuery?: string;
}

interface ListBlock {
  kind: "ul" | "ol";
  items: string[];
}

type TableAlignment = "left" | "center" | "right";

interface TableBlock {
  kind: "table";
  headers: string[];
  alignments: Array<TableAlignment | undefined>;
  rows: string[][];
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "blockquote"; text: string }
  | { kind: "code"; language: string; text: string }
  | { kind: "hr" }
  | ListBlock
  | TableBlock;

function splitTableRow(line: string) {
  const trimmed = line.trim();
  const cells: string[] = [];
  let cell = "";

  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    const nextCharacter = trimmed[index + 1];

    if (character === "\\" && nextCharacter === "|") {
      cell += "|";
      index += 1;
      continue;
    }

    if (character === "|") {
      cells.push(cell.trim());
      cell = "";
      continue;
    }

    cell += character;
  }

  cells.push(cell.trim());

  if (trimmed.startsWith("|")) cells.shift();
  if (trimmed.endsWith("|")) cells.pop();
  return cells;
}

function tableAlignment(separatorCell: string): TableAlignment | undefined {
  const cell = separatorCell.trim();
  if (!/^:?-{3,}:?$/.test(cell)) return undefined;
  if (cell.startsWith(":") && cell.endsWith(":")) return "center";
  if (cell.endsWith(":")) return "right";
  if (cell.startsWith(":")) return "left";
  return undefined;
}

function isTableSeparatorLine(line: string) {
  if (!line.includes("|")) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function normalizeTableCells(cells: string[], columnCount: number) {
  return Array.from({ length: columnCount }, (_, index) => cells[index] ?? "");
}

function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    if (text) blocks.push({ kind: "paragraph", text });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (/^<a\s+id=["'][-\w]+["']\s*><\/a>$/.test(trimmed)) {
      flushParagraph();
      continue;
    }

    const fenceMatch = trimmed.match(/^```([\w-]*)\s*$/);
    if (fenceMatch) {
      flushParagraph();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      blocks.push({ kind: "code", language: fenceMatch[1] ?? "", text: codeLines.join("\n") });
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      blocks.push({ kind: "heading", level: headingMatch[1].length, text: headingMatch[2] });
      continue;
    }

    if (/^[-*_]\s*[-*_]\s*[-*_][-*_\s]*$/.test(trimmed)) {
      flushParagraph();
      blocks.push({ kind: "hr" });
      continue;
    }

    if (
      trimmed.includes("|") &&
      index + 1 < lines.length &&
      isTableSeparatorLine(lines[index + 1])
    ) {
      flushParagraph();

      const headers = splitTableRow(trimmed);
      const alignments = splitTableRow(lines[index + 1]).map(tableAlignment);
      const rows: string[][] = [];
      let rowIndex = index + 2;

      while (rowIndex < lines.length) {
        const rowLine = lines[rowIndex].trim();
        if (!rowLine || !rowLine.includes("|") || isTableSeparatorLine(rowLine)) break;
        rows.push(splitTableRow(rowLine));
        rowIndex += 1;
      }

      const columnCount = Math.max(
        headers.length,
        alignments.length,
        ...rows.map((row) => row.length),
      );

      blocks.push({
        kind: "table",
        headers: normalizeTableCells(headers, columnCount),
        alignments: Array.from({ length: columnCount }, (_, columnIndex) => alignments[columnIndex]),
        rows: rows.map((row) => normalizeTableCells(row, columnCount)),
      });
      index = rowIndex - 1;
      continue;
    }

    const unorderedMatch = trimmed.match(/^[-*+]\s+(.+)$/);
    if (unorderedMatch) {
      flushParagraph();
      const items = [unorderedMatch[1]];
      while (index + 1 < lines.length) {
        const nextMatch = lines[index + 1].trim().match(/^[-*+]\s+(.+)$/);
        if (!nextMatch) break;
        items.push(nextMatch[1]);
        index += 1;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (orderedMatch) {
      flushParagraph();
      const items = [orderedMatch[1]];
      while (index + 1 < lines.length) {
        const nextMatch = lines[index + 1].trim().match(/^\d+[.)]\s+(.+)$/);
        if (!nextMatch) break;
        items.push(nextMatch[1]);
        index += 1;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushParagraph();
      const quoteLines = [trimmed.replace(/^>\s?/, "")];
      while (index + 1 < lines.length && lines[index + 1].trim().startsWith(">")) {
        index += 1;
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
      }
      blocks.push({ kind: "blockquote", text: quoteLines.join(" ") });
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  return blocks;
}

function tableCellStyle(alignment?: TableAlignment) {
  return alignment ? { textAlign: alignment } : undefined;
}

function splitBySearch(text: string, searchQuery?: string): ReactNode[] {
  const query = searchQuery?.trim();
  if (!query) return [text];

  const lowerText = text.toLocaleLowerCase();
  const lowerQuery = query.toLocaleLowerCase();
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (;;) {
    const index = lowerText.indexOf(lowerQuery, cursor);
    if (index === -1) break;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    nodes.push(<mark key={`${index}-${query}`}>{text.slice(index, index + query.length)}</mark>);
    cursor = index + query.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes.length ? nodes : [text];
}

function inlineMarkdown(text: string, searchQuery?: string): ReactNode[] {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|!\[[^\]]*]\([^)]+\)|\[[^\]]+]\([^)]+\))/g);

  return tokens.map((token, index) => {
    const codeMatch = token.match(/^`([^`]+)`$/);
    if (codeMatch) return <code key={index}>{splitBySearch(codeMatch[1], searchQuery)}</code>;

    const boldMatch = token.match(/^\*\*([^*]+)\*\*$/);
    if (boldMatch) return <strong key={index}>{splitBySearch(boldMatch[1], searchQuery)}</strong>;

    const italicMatch = token.match(/^\*([^*]+)\*$/);
    if (italicMatch) return <em key={index}>{splitBySearch(italicMatch[1], searchQuery)}</em>;

    const imageMatch = token.match(/^!\[([^\]]*)]\(([^)]+)\)$/);
    if (imageMatch) {
      return <img key={index} src={imageMatch[2]} alt={imageMatch[1]} loading="lazy" />;
    }

    const linkMatch = token.match(/^\[([^\]]+)]\(([^)]+)\)$/);
    if (linkMatch) {
      return (
        <a key={index} href={linkMatch[2]} target="_blank" rel="noreferrer">
          {splitBySearch(linkMatch[1], searchQuery)}
        </a>
      );
    }

    return <Fragment key={index}>{splitBySearch(token, searchQuery)}</Fragment>;
  });
}

export function MarkdownPreview({ markdown, searchQuery }: MarkdownPreviewProps) {
  const blocks = parseMarkdown(markdown);

  return (
    <article className="markdown-preview">
      {blocks.map((block, index) => {
        if (block.kind === "heading") {
          const Heading = `h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
          return <Heading key={index}>{inlineMarkdown(block.text, searchQuery)}</Heading>;
        }

        if (block.kind === "paragraph") {
          return <p key={index}>{inlineMarkdown(block.text, searchQuery)}</p>;
        }

        if (block.kind === "blockquote") {
          return <blockquote key={index}>{inlineMarkdown(block.text, searchQuery)}</blockquote>;
        }

        if (block.kind === "code") {
          return (
            <pre key={index}>
              {block.language && <span className="markdown-code-language">{block.language}</span>}
              <code>{block.text}</code>
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
                <li key={itemIndex}>{inlineMarkdown(item, searchQuery)}</li>
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
                        {inlineMarkdown(header, searchQuery)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {row.map((cell, columnIndex) => (
                        <td key={columnIndex} style={tableCellStyle(block.alignments[columnIndex])}>
                          {inlineMarkdown(cell, searchQuery)}
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
              <li key={itemIndex}>{inlineMarkdown(item, searchQuery)}</li>
            ))}
          </ol>
        );
      })}
    </article>
  );
}
