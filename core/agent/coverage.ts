import type { CachedPageProvenance } from "../store/index.js";
export function describeCoverage(cached: { provenance: readonly CachedPageProvenance[] | null } | null): { indexStatus: "unknown" | "complete" | "incomplete"; unresolvedPageCount: number | null } {
  if (cached?.provenance == null) return { indexStatus: "unknown", unresolvedPageCount: null };
  const unresolvedPageCount = cached.provenance.filter((page) => page.status === "unresolved").length;
  return { indexStatus: unresolvedPageCount > 0 ? "incomplete" : "complete", unresolvedPageCount };
}
