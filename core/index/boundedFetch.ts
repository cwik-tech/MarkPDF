/**
 * A network bound for model downloads.
 *
 * `env.fetch` is the single funnel for remote bytes during model loading, and the library never
 * sets its own `signal`, so wrapping it imposes a real per-request deadline.
 *
 * The bound is a module constant rather than a per-caller option, and that is deliberate
 * honesty: `env` is a process-wide singleton shared by every caller, so whichever caller
 * installed the wrapper first would have decided the timeout for everyone. Rather than offer an
 * option that silently does not work, the policy is stated once here.
 *
 * A cached model never reaches this wrapper, because a cache hit is a filesystem read.
 */
export const DOWNLOAD_TIMEOUT_MS = 120_000;

export type FetchLike = (input: string | URL, init?: unknown) => Promise<unknown>;

function toInitRecord(init: unknown): Record<string, unknown> {
  // `init` is declared `any` upstream, so it genuinely may not be an object.
  if (typeof init !== "object" || init === null || Array.isArray(init)) return {};
  return { ...(init as Record<string, unknown>) };
}

function combineSignals(existing: unknown, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  // Never discard a signal the caller already set; combine instead, so both remain effective.
  if (existing instanceof AbortSignal) return AbortSignal.any([existing, timeout]);
  return timeout;
}

export function withRequestBound(underlying: FetchLike, timeoutMs: number = DOWNLOAD_TIMEOUT_MS): FetchLike {
  return (input, init) => {
    const request = toInitRecord(init);
    return underlying(input, { ...request, signal: combineSignals(request.signal, timeoutMs) });
  };
}
