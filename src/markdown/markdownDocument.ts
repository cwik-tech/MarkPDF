export type TableAlignment = "left" | "center" | "right";

export interface ListBlock {
  kind: "ul" | "ol";
  items: string[];
}

export interface TableBlock {
  kind: "table";
  headers: string[];
  alignments: Array<TableAlignment | undefined>;
  rows: string[][];
}

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "blockquote"; text: string }
  | { kind: "code"; language: string; text: string }
  | { kind: "hr" }
  | ListBlock
  | TableBlock;

export type InlineToken =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "link"; text: string; url: string }
  | { kind: "image"; alt: string; url: string };

const INLINE_PATTERN =
  /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|!\[[^\]]*]\([^)]+\)|\[[^\]]+]\([^)]+\))/g;

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

export function parseMarkdown(markdown: string): Block[] {
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

export function tokenizeInline(text: string): InlineToken[] {
  return text.split(INLINE_PATTERN).map((token): InlineToken => {
    const codeMatch = token.match(/^`([^`]+)`$/);
    if (codeMatch) return { kind: "code", text: codeMatch[1] };

    const boldMatch = token.match(/^\*\*([^*]+)\*\*$/);
    if (boldMatch) return { kind: "bold", text: boldMatch[1] };

    const italicMatch = token.match(/^\*([^*]+)\*$/);
    if (italicMatch) return { kind: "italic", text: italicMatch[1] };

    const imageMatch = token.match(/^!\[([^\]]*)]\(([^)]+)\)$/);
    if (imageMatch) return { kind: "image", alt: imageMatch[1], url: imageMatch[2] };

    const linkMatch = token.match(/^\[([^\]]+)]\(([^)]+)\)$/);
    if (linkMatch) return { kind: "link", text: linkMatch[1], url: linkMatch[2] };

    return { kind: "text", text: token };
  });
}

export function isMermaidBlock(block: Block) {
  return block.kind === "code" && block.language.toLocaleLowerCase() === "mermaid";
}

/**
 * The readable text of a document, in the order the preview renders it. Search
 * counts matches here so that the nth match is always the nth highlight on
 * screen. Link targets, image sources and image alt text are left out because
 * the preview never shows them as text.
 */
export function collectHighlightableText(blocks: Block[]): string[] {
  const segments: string[] = [];

  const pushInline = (text: string) => {
    for (const token of tokenizeInline(text)) {
      if (token.kind === "image") continue;
      segments.push(token.text);
    }
  };

  for (const block of blocks) {
    switch (block.kind) {
      case "heading":
      case "paragraph":
      case "blockquote":
        pushInline(block.text);
        break;
      case "code":
        if (!isMermaidBlock(block)) segments.push(block.text);
        break;
      case "ul":
      case "ol":
        for (const item of block.items) pushInline(item);
        break;
      case "table":
        for (const header of block.headers) pushInline(header);
        for (const row of block.rows) {
          for (const cell of row) pushInline(cell);
        }
        break;
      case "hr":
        break;
    }
  }

  return segments;
}
