/**
 * `cgraph index` / `cgraph update`
 *
 * Both run the same pipeline; `index --force` re-parses everything, `update`
 * relies on the hash check to touch only what changed.
 */

import { loadConfig } from '../../core/config.js';
import { Store } from '../../core/store.js';
import { Indexer } from '../../core/indexer.js';
import { out, json, color, toks, bytes, duration, pad, padLeft, Progress } from '../ui.js';

export async function run(args) {
  if (args.help) return help();

  const config = loadConfig(process.cwd(), stripUndefined({
    root: args.root,
    workers: args.workers,
  }));

  // A dry run is a pure read: it must never create .cgraph/ as a side effect.
  // Users reach for it precisely to see what *would* happen.
  if (args.dryRun) return dryRun(config, args);

  const store = await Store.open(config.db);
  try {
    const registry = await loadRegistry(config);
    const progress = new Progress('indexing', { quiet: args.quiet || args.json });
    const indexer = new Indexer({ store, config, registry, progress });

    const stats = await indexer.run({ force: !!args.force });
    progress.done();

    // Embeddings are opt-in per run: they cost money and send code to a third
    // party, so they never happen as a side effect of a normal index.
    if (args.embed) {
      const { embedIndex } = await import('../../embed/index.js');
      const embedProgress = new Progress('  embedding', { quiet: args.quiet || args.json });
      const result = await embedIndex(store, config, {
        onProgress: (done, total) => embedProgress.tick(0, `${done}/${total}`),
      });
      embedProgress.done();
      stats.embedded = result.embedded;
      if (result.skipped) {
        out(color.yellow(`  embeddings skipped: ${result.skipped}`));
      }
    }

    if (args.json) return json(serializable(stats));
    report(stats, config, args._command === 'update');
  } finally {
    store.close();
  }
}

async function dryRun(config, args) {
  const indexer = new Indexer({ store: null, config, registry: await loadRegistry(config) });
  const stats = await indexer.run({ dryRun: true });

  if (args.json) {
    return json({ ...serializable(stats), files: stats.files });
  }

  if (args.verbose) {
    for (const f of stats.files) {
      out(`${pad(f.lang ?? '-', 12)} ${padLeft(bytes(f.size), 7)} ${padLeft(toks(f.tok), 7)}  ${f.path}`);
    }
    out('');
  }

  report(stats, config, false, true);
}

function report(stats, config, isUpdate, isDry) {
  const verb = isDry ? 'would index' : isUpdate ? 'updated' : 'indexed';

  out('');
  out(`${color.bold(verb)}  ${config.root}`);
  out('');

  const line = (label, value, note = '') =>
    out(`  ${pad(label, 14)} ${padLeft(value, 8)}  ${color.dim(note)}`);

  line('files seen', stats.seen);
  if (stats.added) line('added', stats.added);
  if (stats.changed) line('changed', stats.changed);
  if (stats.unchanged) line('unchanged', stats.unchanged, 'hash match, skipped');
  if (stats.removed) line('removed', stats.removed, 'deleted from disk');
  if (stats.parsed) line('parsed', stats.parsed);
  if (stats.failed) line('failed', color.red(stats.failed));
  if (stats.skipped) line('skipped', stats.skipped);

  if (stats.byLang.size) {
    out('');
    out(color.dim('  languages'));
    const sorted = [...stats.byLang].sort((a, b) => b[1] - a[1]);
    for (const [lang, n] of sorted.slice(0, 12)) {
      out(`    ${pad(lang, 16)} ${padLeft(n, 6)}`);
    }
    if (sorted.length > 12) out(color.dim(`    ... and ${sorted.length - 12} more`));
  }

  if (stats.bySkip.size) {
    out('');
    out(color.dim('  skipped by reason'));
    for (const [reason, n] of [...stats.bySkip].sort((a, b) => b[1] - a[1])) {
      out(`    ${pad(reason, 16)} ${padLeft(n, 6)}`);
    }
  }

  if (stats.resolution) {
    const r = stats.resolution;
    const total = r.exact + r.inferred;
    // The EXACT share is the honest measure of how much of this graph can be
    // trusted without verification, so it is reported on every index rather
    // than hidden behind a diagnostic command.
    const pct = total ? Math.round((r.exact / total) * 100) : 0;
    out('');
    out(color.dim('  resolution'));
    line('edges', r.edges);
    line('exact', r.exact, `${pct}% of internal edges`);
    line('inferred', r.inferred, 'name match, unverified');
    if (r.external) line('external', r.external, 'into dependencies');
    if (r.unresolved) line('unresolved', r.unresolved, 'see `cgraph doctor`');
  }

  out('');
  out(
    color.dim(
      `  ${bytes(stats.bytes)} of source, ~${toks(stats.tokens)} tokens if read whole` +
        `  ·  ${duration(stats.durationMs)}`
    )
  );
  out('');
}

/**
 * Language packs arrive in P1. Until then the indexer runs without a registry
 * and records file rows only, so the walk can be verified independently of
 * parsing — which is exactly what the P0 exit criterion checks.
 */
async function loadRegistry(config) {
  try {
    const { PackRegistry } = await import('../../packs/registry.js');
    return await PackRegistry.load(config);
  } catch (err) {
    if (err.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}

function serializable(stats) {
  return {
    ...stats,
    byLang: Object.fromEntries(stats.byLang),
    bySkip: Object.fromEntries(stats.bySkip),
    files: undefined,
  };
}

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function help() {
  out(`
${color.bold('cgraph index')} — build or refresh the code index

  cgraph index              Index changed files
  cgraph index --force      Re-parse everything
  cgraph index --dry-run    Show what would be indexed, write nothing
  cgraph update             Alias for the incremental path

${color.bold('OPTIONS')}
  --force        Ignore hashes and re-parse every file
  --dry-run      Walk and report only; does not create .cgraph/
  --verbose      With --dry-run, list every file
  --embed        Also generate embeddings (requires configuration; costs money)
  --workers <n>  Parser worker count (default: cpus - 1)
  --json         Machine-readable output
  --quiet        No progress output
`);
}
