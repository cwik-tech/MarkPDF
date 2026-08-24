import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

const require = createRequire(import.meta.url);

export interface PageImage {
  /** 1-based, matching every other page number in this codebase. */
  page: number;
  /** PNG bytes. */
  image: Uint8Array;
  width: number;
  height: number;
}

export interface RasteriseOptions {
  /** 1-based page numbers to render. Anything outside the document is ignored. */
  pages: readonly number[];
  /** Render resolution. 200 is comfortably above what the recogniser needs for body text. */
  dpi?: number;
  signal?: AbortSignal;
  /**
   * An already-open pdf.js document over these bytes, so the 35 ms open is paid once when the
   * caller holds one — a region walk that found something, for instance. The caller keeps
   * ownership: rendering borrows the handle and does not release it.
   */
  document?: PdfjsDocumentHandle;
}

/**
 * Where pdf.js reads its bundled assets from, in Node.
 *
 * **Plain filesystem paths with a trailing separator, never `file://` URLs.**
 * `pdfjs-dist/legacy/build/pdf.mjs:16022-16026` reads them with `fs.readFile(url)`, so a URL
 * arrives as a literal filename and fails. The trailing separator matters because the library
 * concatenates rather than joins.
 */
function pdfjsAssetPaths(): { standardFontDataUrl: string; cMapUrl: string } {
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  return {
    standardFontDataUrl: `${join(root, "standard_fonts")}${sep}`,
    cMapUrl: `${join(root, "cmaps")}${sep}`,
  };
}

/** Rendering is cancellable between pages; one page's render is not preemptible. */
export class RasterisationCancelled extends Error {
  constructor() {
    super("Rasterisation was cancelled.");
    this.name = "RasterisationCancelled";
  }
}

/**
 * An opened pdf.js document and the right to close it.
 *
 * Reading a document costs one open — measured at 35 ms — which is why more than one reader of
 * the same bytes may share a handle. Whoever opened it is the only one entitled to release it:
 * a borrower that destroyed a handle still in use would fail every later reader of it.
 */
export interface PdfjsDocumentHandle {
  pdf: PDFDocumentProxy;
  release: () => Promise<void>;
}

/**
 * Open a PDF for pdf.js inspection, lazily loading the library the way rendering does.
 *
 * Callers that already hold a handle pass it on instead of calling this again; the 35 ms open
 * is paid once per document, not once per reader.
 */
export async function openPdfDocument(bytes: Uint8Array): Promise<PdfjsDocumentHandle> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = pdfjs.getDocument({
    // Copied, because pdf.js takes ownership of the buffer it is given and the caller still
    // needs these bytes to hash and to extract from.
    data: new Uint8Array(bytes),
    ...pdfjsAssetPaths(),
    cMapPacked: true,
  });
  const pdf = await loading.promise;
  return { pdf, release: () => pdf.destroy() };
}

/**
 * Render selected pages of a PDF to PNG images, in plain Node.
 *
 * pdf.js needs no worker configuration here: `pdf.mjs:22311-22314` disables the worker and
 * imports it in-process when it detects Node. `@napi-rs/canvas` is selected automatically by
 * `pdf.mjs:21531` for the same reason, so nothing has to be injected.
 *
 * Both libraries are imported lazily. They are only needed for a scanned page, and a document
 * with a text layer should not pay for loading a rasteriser it will not use.
 */
export async function* rasterisePdfPagesStreaming(
  bytes: Uint8Array,
  options: RasteriseOptions,
): AsyncIterable<PageImage> {
  if (options.pages.length === 0) return;
  const { createCanvas } = await import("@napi-rs/canvas");

  const scale = (options.dpi ?? 200) / 72;
  // A supplied handle is borrowed, never released; only what this function opens does it close.
  const handle = options.document ?? (await openPdfDocument(bytes));
  const ownsHandle = options.document === undefined;
  const pdf = handle.pdf;
  try {
    for (const page of [...options.pages].sort((a, b) => a - b)) {
      if (options.signal?.aborted === true) throw new RasterisationCancelled();
      if (page < 1 || page > pdf.numPages) continue;

      const rendered = await pdf.getPage(page);
      const viewport = rendered.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      // A scan is ink on paper. Without this the page starts transparent, which encodes as black
      // and gives the recogniser a photographic negative to read.
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      try {
        await rendered.render({ canvasContext: context, viewport, canvas }).promise;
        yield { page, image: canvas.toBuffer("image/png"), width: canvas.width, height: canvas.height };
      } finally {
        rendered.cleanup();
      }
    }
  } finally {
    if (ownsHandle) await handle.release();
  }
}

/** Compatibility collector for callers that genuinely need every rendered image at once. */
export async function rasterisePdfPages(bytes: Uint8Array, options: RasteriseOptions): Promise<PageImage[]> {
  const images: PageImage[] = [];
  for await (const image of rasterisePdfPagesStreaming(bytes, options)) images.push(image);
  return images;
}
