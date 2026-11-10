/**
 * Parser thread entry point. See parse-pool.js.
 *
 * Runs the same `parseBatch` the main thread would, against a registry loaded
 * from the same config, so a file parses identically wherever it lands.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { PackRegistry } from './registry.js';

// The main thread loads the same packs from the same places and has already
// reported anything wrong with them. Repeating each warning once per thread
// would bury the one copy that matters.
process.emitWarning = () => {};

const registry = await PackRegistry.load(workerData.config, workerData.loadOptions);

parentPort.on('message', async (items) => {
  try {
    const results = await registry.parseBatch(
      items.map((it) => ({ file: { rel: it.rel, content: it.content }, lang: it.lang, tok: 0 }))
    );
    parentPort.postMessage({
      results: results.map((r) => ({
        extraction: r.extraction,
        error: r.error,
        skipped: r.skipped ?? null,
      })),
    });
  } catch (err) {
    parentPort.postMessage({ error: String(err?.message ?? err) });
  }
});
