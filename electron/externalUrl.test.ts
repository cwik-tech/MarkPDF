import { describe, expect, it } from "vitest";
import { openableExternalUrl } from "./externalUrl.js";
import { safeLinkUrl } from "../src/pdf/links";

/*
 * Checked by running, not by `tsc`. Like `core/modelParity.test.ts`, this file spans two
 * module-resolution regimes — the main process's on one side, Vite's bundler resolution on the
 * other — so only Vitest can resolve both halves, and `tsconfig.test.json` excludes it by name.
 */

/**
 * The rule the privileged side applies before an address reaches the operating system.
 *
 * The window asks for this, so the address arrives over IPC as `unknown` — from a document anybody
 * can produce, through a renderer that is not the authority on what may be launched. `shell.openExternal`
 * hands a string to the desktop's own handler registry, where a scheme like `vscode:` or `smb:`
 * starts a program rather than a browser tab. So this decides, again, on the side that can enforce it.
 */
describe("the addresses the desktop may be asked to open", () => {
  it("opens the schemes a reader can be sent to", () => {
    for (const url of [
      "https://example.invalid/reference",
      "http://example.invalid/reference",
      "mailto:records@example.invalid",
    ]) {
      expect(openableExternalUrl(url), url).toBe(url);
    }
  });

  it("refuses a scheme that launches something other than a browser or mail client", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "ftp://example.invalid/report.pdf",
      "vscode://file/Users/reader/.ssh/id_rsa",
      "smb://example.invalid/share",
      "ms-msdt:/id PCWDiagnostic",
    ]) {
      expect(openableExternalUrl(url), url).toBeNull();
    }
  });

  it("refuses an address that is not an absolute one, or not a string at all", () => {
    for (const url of ["/etc/passwd", "example.invalid", "", "   ", null, undefined, 7, {}, []]) {
      expect(openableExternalUrl(url), JSON.stringify(url) ?? "undefined").toBeNull();
    }
  });

  it("refuses an address too long to be one a person means to follow", () => {
    expect(openableExternalUrl(`https://example.invalid/${"a".repeat(4096)}`)).toBeNull();
  });
});

/**
 * The window keeps its own copy of this rule, because it must decide whether to draw a link at all
 * and cannot ask a privileged process a question per annotation. Two copies is a duplication, and
 * the failure it invites is silent: a link the window draws and this side then refuses is a dead
 * hitbox the reader clicks and clicks. This is what makes the duplication safe.
 */
describe("the rule the window draws links by and the rule this side opens them by", () => {
  it("answers identically for every address either side has an opinion about", () => {
    for (const url of [
      "https://example.invalid/reference",
      "http://example.invalid/reference",
      "HTTPS://EXAMPLE.INVALID/Reference",
      "mailto:records@example.invalid",
      "https://example.invalid/reference#section-4",
      "https://example.invalid/search?q=governance%20model",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>alert(1)</script>",
      "ftp://example.invalid/report.pdf",
      "vscode://file/Users/reader/.ssh/id_rsa",
      "smb://example.invalid/share",
      "ms-msdt:/id PCWDiagnostic",
      "tel:+441234567890",
      "/etc/passwd",
      "example.invalid/reference",
      "  https://example.invalid/padded  ",
      "",
      `https://example.invalid/${"a".repeat(4096)}`,
    ]) {
      expect(openableExternalUrl(url), url).toBe(safeLinkUrl(url));
    }
  });
});
