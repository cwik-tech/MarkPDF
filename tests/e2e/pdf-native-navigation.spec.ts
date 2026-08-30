import { expect, test, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  NATIVE_NAVIGATION,
  buildNativeNavigationPdf,
  expectedGlyphBox,
} from "../../cli/journeys/nativeNavigationFixture.test-support.js";

/**
 * Three journeys through a tagged PDF, in the real application: finding a word, finding it after
 * the page is turned, and following the document's own links.
 *
 * All three have to run in Electron. What is under test is layout — where the browser puts a
 * text-layer span inside a marked-content wrapper, what the browser's own text-range rectangles
 * measure, and where an annotation rectangle lands once a viewport has been applied to it — and none
 * of that is observable from a pure renderer test. The failures they protect against are also
 * invisible to a DOM assertion that only counts elements: the previous defect produced a highlight
 * element for every match, correctly, at the wrong place on the page.
 *
 * What each journey deliberately leaves alone: which annotation shapes are admitted, and how a match
 * is split across the runs that drew it. Those are rules with many cases, and they belong to
 * `src/pdf/internalLinks.test.ts` and `src/pdf/textLayerSearch.test.ts` rather than to a matrix
 * repeated through the whole application.
 */

const require = createRequire(import.meta.url);
const electronModule: unknown = require("electron");
if (typeof electronModule !== "string") {
  throw new Error("The Electron package did not expose its executable path.");
}
const electronPath = electronModule;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The zoom the journeys run at: deliberately not the 100% the application opens with. */
const ZOOM = 1.1;

interface Fixture {
  tempDir: string;
  userDataPath: string;
  document: string;
}

async function makeFixture(): Promise<Fixture> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "markpdf-native-nav-"));
  const userDataPath = path.join(tempDir, "user-data");
  await mkdir(userDataPath, { recursive: true });
  const document = path.join(tempDir, "governance-handbook.pdf");
  await writeFile(document, await buildNativeNavigationPdf());
  return { tempDir, userDataPath, document };
}

function launch(fixture: Fixture): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: electronPath,
    args: [path.join(projectRoot, "dist-electron/bootstrap.js"), fixture.document],
    env: {
      ...process.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      MARKPDF_TEST_USER_DATA: fixture.userDataPath,
      MARKPDF_DATA_DIR: fixture.userDataPath,
      MARKPDF_E2E_EMBEDDER: "deterministic",
      VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
    },
  });
}

async function closeApp(app: ElectronApplication | null): Promise<void> {
  if (app === null) return;
  await app.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => undefined);
  await app.close().catch(() => undefined);
}

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface PageGeometry {
  /** The rendered page box, in viewport coordinates. */
  page: Box;
  /** The document pane, so "brought into view" can be checked rather than assumed. */
  pane: Box;
  /** How many marked-content wrappers the layer holds. Zero means the fixture is not tagged. */
  wrappers: number;
  /** Leaf text spans whose text contains the needle, with their measured boxes. */
  leaves: Array<{ text: string; box: Box }>;
  /** Every search highlight currently drawn over this page. */
  markers: Box[];
}

/**
 * Measure the page in one pass inside the renderer.
 *
 * Boxes come back in viewport coordinates and are converted to page-relative coordinates in the
 * assertions, so a scrolled pane cannot change what a position means.
 */
async function measurePage(window: Page, pageNumber: number, needle: string): Promise<PageGeometry> {
  return window.evaluate(
    ({ pageNumber, needle }) => {
      const toBox = (element: Element): Box => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      };
      const wrap = document.querySelector(`.page-wrap[data-page-number="${pageNumber}"]`);
      if (wrap === null) throw new Error(`No rendered page ${pageNumber}.`);
      const pageElement = wrap.querySelector(".pdf-page");
      const pane = wrap.closest(".document-scroll");
      const textLayer = wrap.querySelector(`[data-testid="text-layer-${pageNumber}"]`);
      if (pageElement === null || pane === null || textLayer === null) {
        throw new Error(`Page ${pageNumber} is missing its page box, pane, or text layer.`);
      }
      const leaves = Array.from(textLayer.querySelectorAll("span:not(.markedContent)"))
        .filter((span) => (span.textContent ?? "").includes(needle))
        .map((span) => ({ text: span.textContent ?? "", box: toBox(span) }));
      return {
        page: toBox(pageElement),
        pane: toBox(pane),
        wrappers: textLayer.querySelectorAll("span.markedContent").length,
        leaves,
        markers: Array.from(wrap.querySelectorAll(".search-highlight-layer .search-hit")).map(toBox),
      } satisfies PageGeometry;
    },
    { pageNumber, needle },
  );
}

/** Whether two boxes share any area at all. */
function overlaps(a: Box, b: Box): boolean {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  );
}

/** A box's position relative to the page's top-left corner. */
function relativeTo(page: Box, box: Box): { left: number; top: number } {
  return { left: box.left - page.left, top: box.top - page.top };
}

async function searchFor(window: Page, query: string): Promise<void> {
  const input = window.getByPlaceholder("Find text");
  await input.click();
  await input.fill(query);
  await input.press("Enter");
}

test("highlights a tagged PDF's text over the matching glyphs and steps to the next occurrence", async () => {
  test.setTimeout(120_000);

  const fixture = await makeFixture();
  let app: ElectronApplication | null = null;

  try {
    // Arrange: the tagged handbook, opened at a zoom the application did not choose for itself.
    app = await launch(fixture);
    const window = await app.firstWindow();
    await expect(window.getByTestId("text-layer-1")).toBeVisible({ timeout: 30_000 });
    await window.getByRole("button", { name: "Zoom in" }).click();
    await expect(window.locator(".zoom-label")).toHaveText(`${Math.round(ZOOM * 100)}%`);

    // Act: search for the word this document says twice, on one page, far apart.
    await searchFor(window, NATIVE_NAVIGATION.repeated.word);
    await expect(window.locator(".search-count")).toHaveText("1/2", { timeout: 30_000 });
    await expect(
      window.getByTestId(`text-layer-${NATIVE_NAVIGATION.repeated.page}`),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      window.locator(
        `.page-wrap[data-page-number="${NATIVE_NAVIGATION.repeated.page}"] .search-hit`,
      ).first(),
    ).toBeVisible({ timeout: 30_000 });

    const first = await measurePage(
      window,
      NATIVE_NAVIGATION.repeated.page,
      NATIVE_NAVIGATION.repeated.word,
    );

    // The fixture really is tagged, so this journey is observing the wrapper case.
    expect(first.wrappers, "marked-content wrappers in the text layer").toBeGreaterThan(0);
    expect(first.leaves.length, "leaf spans carrying the searched word").toBe(2);
    expect(first.markers.length, "highlight rectangles for the active match").toBeGreaterThan(0);

    // Assert: the highlight sits where this document drew the word, not at the page origin.
    // The expected position is computed from the fixture's own PDF coordinates and the zoom, never
    // from anything the renderer measured. The tolerance is one line of body text, which covers the
    // difference between a baseline and a glyph-box top without admitting the origin.
    const tolerance = NATIVE_NAVIGATION.bodySize * ZOOM * 2;
    const expectedFirst = expectedGlyphBox(
      NATIVE_NAVIGATION.repeated.firstBaselineY,
      NATIVE_NAVIGATION.repeated.x,
      ZOOM,
    );
    const activeFirst = relativeTo(first.page, first.markers[0]!);
    expect(Math.abs(activeFirst.left - expectedFirst.left)).toBeLessThan(tolerance);
    expect(Math.abs(activeFirst.top - expectedFirst.top)).toBeLessThan(tolerance);

    const firstLeaf = first.leaves.find((leaf) =>
      leaf.text.includes(NATIVE_NAVIGATION.repeated.firstLine.slice(0, 24)),
    );
    expect(firstLeaf, "the leaf span holding the first occurrence").toBeDefined();
    for (const marker of first.markers) {
      expect(overlaps(marker, firstLeaf!.box), "a highlight that misses its glyphs").toBe(true);
    }

    // And it was brought into the reader's view rather than merely drawn somewhere.
    expect(overlaps(first.markers[0]!, first.pane), "the highlight is inside the document pane").toBe(
      true,
    );

    // Act: step to the other occurrence on the same page.
    await window.getByRole("button", { name: "Next match" }).click();
    await expect(window.locator(".search-count")).toHaveText("2/2");

    const second = await measurePage(
      window,
      NATIVE_NAVIGATION.repeated.page,
      NATIVE_NAVIGATION.repeated.word,
    );
    const expectedSecond = expectedGlyphBox(
      NATIVE_NAVIGATION.repeated.secondBaselineY,
      NATIVE_NAVIGATION.repeated.x,
      ZOOM,
    );
    const activeSecond = relativeTo(second.page, second.markers[0]!);
    expect(Math.abs(activeSecond.top - expectedSecond.top)).toBeLessThan(tolerance);
    expect(
      activeSecond.top - activeFirst.top,
      "the second occurrence is far below the first",
    ).toBeGreaterThan(100);
  } finally {
    await closeApp(app);
    await rm(fixture.tempDir, { recursive: true, force: true });
  }
});

test("keeps a tagged PDF's highlight over the glyphs after the page is rotated", async () => {
  test.setTimeout(120_000);

  const fixture = await makeFixture();
  let app: ElectronApplication | null = null;

  try {
    // Arrange: the same handbook, turned a quarter turn clockwise before anything is searched.
    // PDF.js lays the text layer out in the page's own upright box whatever the view rotation is,
    // so a rotated page is the case where a layer that is merely the right size is still in the
    // wrong place.
    app = await launch(fixture);
    const window = await app.firstWindow();
    await expect(window.getByTestId("text-layer-1")).toBeVisible({ timeout: 30_000 });
    await window.getByRole("button", { name: "Rotate page view" }).click();

    // Act: find the word this document draws near the top of page 2.
    await searchFor(window, NATIVE_NAVIGATION.repeated.word);
    await expect(window.locator(".search-count")).toHaveText("1/2", { timeout: 30_000 });
    await expect(
      window.locator(
        `.page-wrap[data-page-number="${NATIVE_NAVIGATION.repeated.page}"] .search-hit`,
      ).first(),
    ).toBeVisible({ timeout: 30_000 });

    const measured = await measurePage(
      window,
      NATIVE_NAVIGATION.repeated.page,
      NATIVE_NAVIGATION.repeated.word,
    );

    // Assert: a quarter turn clockwise sends the page's top edge to its right edge, so text drawn
    // near the top-left of the upright page belongs near the top-right of the rotated one. Both
    // coordinates are derived from the fixture's own PDF coordinates and the rotation, not from
    // anything the renderer measured.
    expect(measured.page.width, "the page box turned with the view").toBeGreaterThan(
      measured.page.height,
    );
    // A quarter turn clockwise maps an upright box [x, x + w] x [y, y + h] to
    // [H - y - h, H - y] x [x, x + w], where H is the upright page height. Its top-left corner is
    // therefore one line of text in from the rotated page's right edge.
    const upright = expectedGlyphBox(
      NATIVE_NAVIGATION.repeated.firstBaselineY,
      NATIVE_NAVIGATION.repeated.x,
      1,
    );
    const expectedLeft =
      NATIVE_NAVIGATION.pageHeight - upright.top - NATIVE_NAVIGATION.bodySize;
    const expectedTop = upright.left;
    const tolerance = NATIVE_NAVIGATION.bodySize * 2;

    const active = relativeTo(measured.page, measured.markers[0]!);
    expect(Math.abs(active.left - expectedLeft)).toBeLessThan(tolerance);
    expect(Math.abs(active.top - expectedTop)).toBeLessThan(tolerance);

    const firstLeaf = measured.leaves.find((leaf) =>
      leaf.text.includes(NATIVE_NAVIGATION.repeated.firstLine.slice(0, 24)),
    );
    expect(firstLeaf, "the leaf span holding the first occurrence").toBeDefined();
    expect(overlaps(measured.markers[0]!, firstLeaf!.box)).toBe(true);
  } finally {
    await closeApp(app);
    await rm(fixture.tempDir, { recursive: true, force: true });
  }
});

/** Type a page number into the toolbar's page box and commit it. */
async function goToPage(window: Page, pageNumber: number): Promise<void> {
  const box = window.locator(".page-box input");
  await box.fill(String(pageNumber));
  await box.press("Enter");
  await expect(window.getByTestId(`text-layer-${pageNumber}`)).toBeVisible({ timeout: 30_000 });
}

test("follows an internal PDF link from the table of contents", async () => {
  test.setTimeout(120_000);

  const fixture = await makeFixture();
  let app: ElectronApplication | null = null;

  try {
    // Arrange: the contents page, which carries five annotations of which exactly two are internal
    // links a reader may follow.
    app = await launch(fixture);
    const window = await app.firstWindow();
    await expect(window.getByTestId("text-layer-1")).toBeVisible({ timeout: 30_000 });

    const links = window.locator(
      `.page-wrap[data-page-number="${NATIVE_NAVIGATION.contentsPage}"] .native-link-layer .native-link`,
    );
    await expect(links).toHaveCount(NATIVE_NAVIGATION.expectedLinkCount, { timeout: 30_000 });

    // Act: follow the row whose link carries an explicit destination.
    await window
      .getByRole("button", { name: `Go to page ${NATIVE_NAVIGATION.explicitRow.destinationPage}` })
      .click();

    // Assert: the document moved to the encoded page, inside MarkPDF.
    await expect(window.locator(".page-box input")).toHaveValue(
      String(NATIVE_NAVIGATION.explicitRow.destinationPage),
    );
    await expect(
      window
        .getByTestId(`text-layer-${NATIVE_NAVIGATION.explicitRow.destinationPage}`)
        .getByText(NATIVE_NAVIGATION.headings.page2, { exact: false }),
    ).toBeVisible({ timeout: 30_000 });

    // Act: come back and follow the row whose link is a named destination resolved through the
    // catalogue's name tree — the form a real book's contents page uses.
    await goToPage(window, NATIVE_NAVIGATION.contentsPage);
    await window
      .getByRole("button", { name: `Go to page ${NATIVE_NAVIGATION.namedRow.destinationPage}` })
      .click();

    await expect(window.locator(".page-box input")).toHaveValue(
      String(NATIVE_NAVIGATION.namedRow.destinationPage),
    );
    await expect(
      window
        .getByTestId(`text-layer-${NATIVE_NAVIGATION.namedRow.destinationPage}`)
        .getByText(NATIVE_NAVIGATION.headings.page3, { exact: false }),
    ).toBeVisible({ timeout: 30_000 });

    // And nothing left the application: no second window, and the renderer is still on its own
    // document rather than on the address a `/URI` annotation names.
    expect(app.windows(), "extra windows opened by following a link").toHaveLength(1);
    expect(window.url()).not.toContain(NATIVE_NAVIGATION.externalRow.url);
  } finally {
    await closeApp(app);
    await rm(fixture.tempDir, { recursive: true, force: true });
  }
});
