/**
 * Which addresses this application may ask the desktop to open.
 *
 * `shell.openExternal` is not "open a browser tab": it hands a string to the operating system's
 * handler registry, and the registry answers for far more than the web. `vscode:`, `smb:` and
 * `ms-msdt:` each start a program with an argument the document chose; `file:` names something on
 * the reader's own disk. So the rule is an allow list of the two things a link in a document is
 * ever meant to be — a page to read and a message to send — and everything else is refused.
 *
 * The window applies the same rule in `src/pdf/links.ts` before drawing a link at all, because it
 * cannot ask this process a question per annotation. That copy decides what is worth drawing; this
 * one decides what is opened, and it is the one that has to hold. `electron/externalUrl.test.ts`
 * holds the two to the same answers.
 */

/** A page to read, or a message to send. Mirrored by `OPENABLE_LINK_SCHEMES` in the window. */
const OPENABLE_SCHEMES = ["http:", "https:", "mailto:"] as const;

/** Mirrored by `MAX_LINK_URL_LENGTH` in the window. */
const MAX_URL_LENGTH = 4096;

/**
 * The address to open, normalised, or nothing.
 *
 * Arrives over IPC as `unknown`: a string a document supplied, forwarded by a window that is not
 * the authority on what this machine may launch. Returns the URL parser's own `href` so that both
 * sides of the bridge agree on one spelling of an address rather than on two.
 */
export function openableExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Not absolute, or not an address. Nothing here resolves a relative one: there is no page for
    // it to be relative to, and the nearest thing — the document's own file — is on the reader's disk.
    return null;
  }
  const scheme = parsed.protocol;
  return OPENABLE_SCHEMES.some((allowed) => allowed === scheme) ? parsed.href : null;
}
