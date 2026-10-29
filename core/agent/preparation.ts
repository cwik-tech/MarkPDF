import { extname, isAbsolute } from "node:path";
export const preparationStages = ["open", "save", "index", "complete", "transport"] as const;
export const preparationFailureCodes = ["access_or_source", "unsupported_pdf", "user_edits_or_busy", "window_closed", "timeout", "cancelled", "index_failed", "save_failed", "unknown"] as const;
function isMember<T extends readonly string[]>(values: T, value: unknown): value is T[number] { return values.some((entry) => entry === value); }
export interface PreparationReply {
  stage?: typeof preparationStages[number];
  reasonCode?: typeof preparationFailureCodes[number];
  remedy?: string;
  requestId?: string;
  ref?: string;
  tabId?: string;
  modelId?: string;
  chunkingProfile?: string;
  indexStatus?: string;
  textSource?: string;
  chunkCount?: number;
  unresolvedPageCount?: number;
  coverageTruncated?: boolean;
  fallback?: string;

  status: "ready" | "incomplete" | "needs_user_action" | "failed" | "cancelled";
  save: "saved" | "not_needed" | "blocked" | "failed" | "unknown";
  contentHash?: string;
  reason?: string;
  pageCount?: number;
  unresolvedPages?: number[];
}
export function parsePreparationReply(value: unknown): PreparationReply {
  if (typeof value !== "object" || value === null) throw new Error("Invalid preparation reply");
  if (!("status" in value) || !("save" in value)) throw new Error("Incomplete preparation reply");
  const status = value.status;
  const save = value.save;
  if (status !== "ready" && status !== "incomplete" && status !== "needs_user_action" && status !== "failed" && status !== "cancelled") throw new Error("Invalid preparation status");
  if (save !== "saved" && save !== "not_needed" && save !== "blocked" && save !== "failed" && save !== "unknown") throw new Error("Invalid save status");
  const reply: PreparationReply = { status, save };
  if ("contentHash" in value) {
    if (typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(value.contentHash)) throw new Error("Invalid prepared identity");
    reply.contentHash = value.contentHash;
  }
  if ("reason" in value) {
    if (typeof value.reason !== "string" || value.reason.length > 2048) throw new Error("Invalid preparation reason");
    reply.reason = value.reason;
  }
  if ("pageCount" in value) {
    if (typeof value.pageCount !== "number" || !Number.isSafeInteger(value.pageCount) || value.pageCount < 0) throw new Error("Invalid page count");
    reply.pageCount = value.pageCount;
  }
  if ("unresolvedPages" in value) {
    if (!Array.isArray(value.unresolvedPages) || value.unresolvedPages.length > 10000) throw new Error("Invalid page coverage");
    reply.unresolvedPages = value.unresolvedPages.map((page: unknown) => {
      if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1) throw new Error("Invalid unresolved page");
      return page;
    });
  }
  for (const name of ["requestId", "ref", "tabId", "modelId", "chunkingProfile", "indexStatus", "textSource", "fallback", "remedy"] as const) {
    if (name in value) {
      const field: unknown = Reflect.get(value, name);
      if (typeof field !== "string" || field.length > 256 || /[\x00-\x1f]/.test(field)) throw new Error(`Invalid ${name}`);
      reply[name] = field;
    }
  }
  for (const name of ["chunkCount", "unresolvedPageCount"] as const) {
    if (name in value) {
      const field: unknown = Reflect.get(value, name);
      if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) throw new Error(`Invalid ${name}`);
      reply[name] = field;
    }
  }
  if ("coverageTruncated" in value) {
    if (typeof value.coverageTruncated !== "boolean") throw new Error("Invalid coverage truncation");
    reply.coverageTruncated = value.coverageTruncated;
  }
  if ((status === "ready" || status === "incomplete") && reply.contentHash === undefined) throw new Error("Missing prepared document identity");
  if ("stage" in value) { if (!isMember(preparationStages, value.stage)) throw new Error("Invalid preparation stage"); reply.stage = value.stage; }
  if ("reasonCode" in value) { if (!isMember(preparationFailureCodes, value.reasonCode)) throw new Error("Invalid failure code"); reply.reasonCode = value.reasonCode; }
  return reply;
}

export function requirePreparationPath(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || /[\x00-\x1f]/.test(value)) throw new Error("Preparation requires a valid PDF path");
  if (!isAbsolute(value)) throw new Error("Preparation requires an absolute PDF path");
  if (extname(value).toLowerCase() !== ".pdf") throw new Error("Preparation accepts PDF files only");
  return value;
}
