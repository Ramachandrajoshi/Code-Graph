/**
 * `cgraph watch` — keep the index fresh as files change.
 *
 * Uses `fs.watch` rather than chokidar. Node's recursive watch is supported on
 * Windows and macOS natively, and on Linux since Node 20 — which covers the
 * platforms this tool targets, and keeps the dependency count at zero.
 *
 * Changes are debounced and coalesced: editors write files several times in
 * quick succession (temp file, rename, touch), and re-indexing on every event
 * would thrash.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../core/config.js';
import { Store } from '../../core/store.js';
import { Indexer } from '../../core/indexer.js';
import { PackRegistry } from '../../packs/registry.js';
import { out, color, duration } from '../ui.js';

const DEBOUNCE_MS = 250;

export async function run(args) {
  if (args.help) return help();

  const config = loadConfig(process.cwd(), args.root ? { root: args.root } : {});
  const store = await Store.open(config.db, { create: false });
  const registry = await PackRegistry.load(config);
  const indexer = new Indexer({ store, config, registry });

  out(`watching ${config.root}`);
  out(color.dim('ctrl-c to stop'));

  let timer = null;
  let running = false;
  let queued = false;

  const reindex = async () => {
    // Overlapping index runs would corrupt each other's transactions, so a
    // change arriving mid-run sets a flag instead of starting a second pass.
    if (running) { queued = true; return; }
    running = true;

    try {
      const started = Date.now();
      const stats = await indexer.run({});
      if (stats.added || stats.changed || stats.removed) {
        const parts = [];
        if (stats.added) parts.push(`+${stats.added}`);
        if (stats.changed) parts.push(`~${stats.changed}`);
        if (stats.removed) parts.push(`-${stats.removed}`);
        out(`${new Date().toLocaleTimeString()}  ${parts.join(' ')}  ${color.dim(duration(Date.now() - started))}`);
      }
    } catch (err) {
      // A transient error (file deleted mid-read, editor lock) must not kill a
      // watcher the user expects to run all day.
      out(color.red(`  index error: ${err.message}`));
    } finally {
      running = false;
      if (queued) { queued = false; schedule(); }
    }
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(reindex, DEBOUNCE_MS);
  };

  let watcher;
  try {
    watcher = fs.watch(config.root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.replace(/\\/g, '/');
      // Ignore our own writes, or the watcher would trigger itself forever.
      if (rel.startsWith('.cgraph/') || rel.startsWith('.git/')) return;
      schedule();
    });
  } catch (err) {
    throw new Error(
      `Cannot watch ${config.root}: ${err.message}\n` +
        'Recursive watching may be unavailable on this platform; use `cgraph update` instead.'
    );
  }

  const shutdown = () => {
    watcher.close();
    registry.dispose();
    store.close();
    out('');
    out('stopped');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {}); // run until signalled
}

function help() {
  out(`
${color.bold('cgraph watch')} — re-index automatically as files change

${color.bold('OPTIONS')}
  --root <dir>   Project directory
`);
}
