/**
 * What the main process accepts when a window asks it to save a diagram.
 *
 * The window sends the SVG text and the file name to offer. The main process shows the save
 * dialog and writes the file, so the folder always comes from the reader's answer to the dialog
 * and never from the window. Both arguments arrive over IPC as `unknown`.
 */

/** A rendered Mermaid chart is tens or hundreds of kilobytes. This bound is far above that. */
export const MAX_DIAGRAM_SVG_LENGTH = 16 * 1024 * 1024;

const DEFAULT_FILE_NAME = "diagram.svg";
const MAX_FILE_NAME_LENGTH = 200;

/** An SVG document, optionally after an XML declaration and white space. */
const SVG_DOCUMENT = /^\s*(<\?xml[^>]*\?>\s*)?<svg[\s>]/;

function offeredFileName(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_FILE_NAME;
  // Only the last segment of either separator style: a name, not a place.
  const lastSegment = value.split(/[\\/]/).pop() ?? "";
  // Control characters have no place in a name a dialog shows.
  const cleaned = lastSegment.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return DEFAULT_FILE_NAME;
  const named = /\.svg$/i.test(cleaned) ? cleaned : `${cleaned}.svg`;
  return named.length > MAX_FILE_NAME_LENGTH ? DEFAULT_FILE_NAME : named;
}

/** The request to act on, or null when the content is not an SVG document this process writes. */
export function diagramSaveRequest(
  fileName: unknown,
  svg: unknown,
): { fileName: string; svg: string } | null {
  if (typeof svg !== "string") return null;
  if (svg.length === 0 || svg.length > MAX_DIAGRAM_SVG_LENGTH) return null;
  if (!SVG_DOCUMENT.test(svg)) return null;
  return { fileName: offeredFileName(fileName), svg };
}
