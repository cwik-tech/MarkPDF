/**
 * A promise with its resolver exposed, for tests that need to control ordering exactly.
 *
 * Used instead of timers: a test that sleeps is slow when it passes and flaky when the machine
 * is loaded. A latch makes the interleaving deterministic.
 *
 * The `.test-support.ts` suffix is excluded from `tsconfig.core.json`, so this never reaches
 * `dist-core/` and is never packaged. It is test scaffolding, not a core module.
 */
export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
