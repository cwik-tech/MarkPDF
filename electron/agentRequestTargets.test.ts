import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDocumentReference, type OpenDocumentEntry, type OpenDocumentsView } from "../dist-core/session/openDocuments.js";
import { decideRequestTarget } from "./agentRequestTargets.js";

/**
 * Where the desktop sends an agent's request, decided again in the desktop.
 *
 * The client checked all of this already, and the desktop does not care: any process of the same
 * user can write a request file. So every rule that protects the person's documents is applied
 * here, against the consent record as it is now.
 */

const PID = 4242;
let library: string;
let outside: string;

function entry(path: string | null, overrides: Partial<OpenDocumentEntry> = {}): OpenDocumentEntry {
  const tabId = overrides.tabId ?? "tab-a";
  const process = overrides.process ?? PID;
  const window = overrides.window ?? 1;
  return {
    tabId,
    kind: "pdf",
    name: "contract.pdf",
    path,
    pageCount: 3,
    currentPage: 1,
    contentHash: null,
    hasContentSnapshot: false,
    contentChars: 0,
    contentBytes: 0,
    snapshotTruncated: false,
    unsavedChanges: false,
    ref: openDocumentReference(process, window, tabId),
    window,
    process,
    activeInWindow: true,
    active: true,
    ...overrides,
  };
}

function view(...documents: OpenDocumentEntry[]): OpenDocumentsView {
  return { windows: 1, activeRef: documents[0]?.ref ?? null, documents, unreadableWindows: 0 };
}

beforeEach(() => {
  library = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-targets-lib-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "markpdf-targets-out-")));
  writeFileSync(join(library, "contract.pdf"), "%PDF-1.7");
  writeFileSync(join(outside, "secret.pdf"), "%PDF-1.7");
});

afterEach(() => {
  for (const directory of [library, outside]) rmSync(directory, { recursive: true, force: true });
});

const granted = () => ({ readRoots: [library], writeRoots: [] });

describe("decideRequestTarget", () => {
  it("sends a request for an open tab of this process to that tab, when its file may be read", () => {
    const open = entry(join(library, "contract.pdf"));
    expect(decideRequestTarget({ ref: open.ref }, "reveal", { pid: PID, view: view(open), allowlist: granted() })).toEqual({
      kind: "open-tab",
      window: 1,
      tabId: "tab-a",
      ref: open.ref,
    });
  });

  it("refuses an open tab whose file is outside the grants, even though it is open", () => {
    // Matching a quote against the live document would tell the agent about text it cannot read.
    const open = entry(join(outside, "secret.pdf"));
    expect(decideRequestTarget({ ref: open.ref }, "reveal", { pid: PID, view: view(open), allowlist: granted() })).toMatchObject({
      kind: "refuse",
      reason: "access_denied",
    });
  });

  it("refuses a reference that belongs to another MarkPDF process, or to no tab at all", () => {
    const foreign = entry(join(library, "contract.pdf"), { process: 9999 });
    expect(decideRequestTarget({ ref: foreign.ref }, "reveal", { pid: PID, view: view(foreign), allowlist: granted() })).toMatchObject({
      kind: "refuse",
      reason: "stale_ref",
    });
    expect(decideRequestTarget({ ref: "4242-1:gone" }, "reveal", { pid: PID, view: view(), allowlist: granted() })).toMatchObject({
      kind: "refuse",
      reason: "stale_ref",
    });
  });

  it("refuses a path open in two tabs, because it cannot know which one the agent means", () => {
    const path = join(library, "contract.pdf");
    const both = view(entry(path), entry(path, { tabId: "tab-b" }));
    expect(decideRequestTarget({ path }, "reveal", { pid: PID, view: both, allowlist: granted() })).toMatchObject({
      kind: "refuse",
      reason: "ambiguous",
    });
  });

  it("opens a granted file that is not open for a reveal, and refuses an ungranted one", () => {
    const path = join(library, "contract.pdf");
    expect(decideRequestTarget({ path }, "reveal", { pid: PID, view: view(), allowlist: granted() })).toEqual({ kind: "open-file", path });
    expect(
      decideRequestTarget({ path: join(outside, "secret.pdf") }, "reveal", { pid: PID, view: view(), allowlist: granted() }),
    ).toMatchObject({ kind: "refuse", reason: "access_denied" });
  });

  it("never opens a document for a suggestion", () => {
    const path = join(library, "contract.pdf");
    expect(decideRequestTarget({ path }, "suggest", { pid: PID, view: view(), allowlist: granted() })).toMatchObject({
      kind: "refuse",
      reason: "not_open",
    });
  });
});
