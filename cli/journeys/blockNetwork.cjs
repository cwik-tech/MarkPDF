/**
 * Make any network access throw, in this process and in every worker thread it starts.
 *
 * Loaded with `NODE_OPTIONS=--require`, which propagates into `worker_threads` — verified, and
 * the reason this is a real check rather than an assertion about configuration. Tesseract's Node
 * worker runs in a worker thread and reaches for a CDN unless it is given local language data, so
 * patching only the main thread would prove nothing about the code path that actually matters.
 */
const refuse = () => {
  throw new Error("NETWORK BLOCKED: this run is supposed to be offline.");
};

globalThis.fetch = refuse;
for (const name of ["node:http", "node:https"]) {
  const module = require(name);
  module.request = refuse;
  module.get = refuse;
}
