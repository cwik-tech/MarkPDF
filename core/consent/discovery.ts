import { containsPath, type Allowlist } from "./allowlist.js";
import type { StoredDocument } from "../store/index.js";

/**
 * Which indexed documents an agent's library search may discover.
 *
 * A document is discoverable when MarkPDF itself resolved its path when it read it — so the recorded
 * path is canonical and is where the indexed bytes came from — and that path is inside a current
 * read root. Anything else is left out: a path the app passed along unresolved can run through a link
 * to a folder nobody granted, and a document with no path has no folder to be granted.
 *
 * **No filesystem call.** Roots are canonical (see `Allowlist`), the recorded path is canonical by its
 * provenance, and containment between two canonical paths is string arithmetic. Resolving the recorded
 * path now would touch the filesystem — which this search must never do — and would judge the folder
 * as it is today rather than the folder the indexed copy came from.
 *
 * This limits discovery, not access. A document an agent can already name by its hash is answered as
 * before; see the consent ADR.
 */
export function agentDiscovery(allowlist: Allowlist): (entry: StoredDocument) => boolean {
  const roots = [...allowlist.readRoots];
  return (entry) => {
    if (entry.pathProvenance !== "resolved" || entry.filePath === null) return false;
    const path = entry.filePath;
    return roots.some((root) => containsPath(root, path));
  };
}
