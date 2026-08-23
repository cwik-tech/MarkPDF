import { StoreDataError } from "./errors.js";

/**
 * Everything SQLite hands back is external input.
 *
 * better-sqlite3 returns `unknown`-shaped objects, and the file on disk may have been written
 * by an older build, a different tool, or damaged hardware. A cast (`as { count: number }`)
 * asserts a shape without checking it, so a corrupt row becomes `NaN` or `"undefined"` several
 * layers away from the cause. These guards construct the typed value and fail at the boundary
 * instead.
 */

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value instanceof Uint8Array) return `blob(${value.byteLength})`;
  return `${typeof value}`;
}

export function asRow(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StoreDataError(`${context}: expected a row object, received ${describe(value)}.`);
  }
  return value as Record<string, unknown>;
}

export function requireString(row: Record<string, unknown>, column: string, context: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new StoreDataError(`${context}: column "${column}" should be text, received ${describe(value)}.`);
  }
  return value;
}

export function requireNullableString(row: Record<string, unknown>, column: string, context: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new StoreDataError(`${context}: column "${column}" should be text or null, received ${describe(value)}.`);
  }
  return value;
}

export function requireInteger(row: Record<string, unknown>, column: string, context: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new StoreDataError(`${context}: column "${column}" should be an integer, received ${describe(value)}.`);
  }
  return value;
}

export function requireBlob(row: Record<string, unknown>, column: string, context: string): Uint8Array {
  const value = row[column];
  if (!(value instanceof Uint8Array)) {
    throw new StoreDataError(`${context}: column "${column}" should be a blob, received ${describe(value)}.`);
  }
  return value;
}

/** `PRAGMA x` in simple mode returns a bare scalar of whatever type the pragma yields. */
export function pragmaInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new StoreDataError(`PRAGMA ${name} should return an integer, received ${describe(value)}.`);
  }
  return value;
}

export function pragmaText(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new StoreDataError(`PRAGMA ${name} should return text, received ${describe(value)}.`);
  }
  return value;
}

/** A single-column COUNT(*) result. */
export function countFrom(value: unknown, context: string): number {
  return requireInteger(asRow(value, context), "count", context);
}

/**
 * `heading_path` is JSON written by this codebase, but the column is plain text and a foreign
 * writer could put anything there. An unreadable breadcrumb degrades to empty rather than
 * failing a search, because the page number — the load-bearing part — is still valid.
 */
export function parseHeadingPath(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === "string");
}
