/**
 * `cgraph doctor` — index health and resolution quality.
 *
 * The point of this command is to make quality *visible*. A graph that silently
 * resolves 40% of its references is worse than useless — it looks authoritative
 * while being mostly guesswork. Reporting the exact/inferred/unresolved split
 * per language turns that from an invisible property into a number that can
 * regress a test.
 */

import { loadConfig } from '../../core/config.js';
import { Store } from '../../core/store.js';
import { PackRegistry } from '../../packs/registry.js';
import { localGrammars, KNOWN_GRAMMARS, grammarInfo } from '../../core/grammars.js';
import { out, json, color, pad, padLeft, duration } from '../ui.js';

export async function run(args) {
  if (args.help) return help();

  const config = loadConfig(process.cwd(), args.root ? { root: args.root } : {});
  const store = await Store.open(config.db, { create: false });

  try {
    const report = await buildReport(store, config);
    if (args.json) return json(report);
    render(report);
  } finally {
    store.close();
  }
}

async function buildReport(store, config) {
  const stats = store.stats();

  const byLang = store.all(
    `SELECT f.lang,
            COUNT(DISTINCT f.id) AS files,
            SUM(CASE WHEN f.parsed = 1 THEN 1 ELSE 0 END) AS parsed
       FROM files f WHERE f.lang IS NOT NULL
      GROUP BY f.lang ORDER BY files DESC`
  );

  const resolution = store.all(
    `SELECT f.lang,
            SUM(CASE WHEN e.confidence = 'EXACT' THEN 1 ELSE 0 END) AS exact,
            SUM(CASE WHEN e.confidence = 'INFERRED' THEN 1 ELSE 0 END) AS inferred
       FROM edges e JOIN files f ON f.id = e.file_id
      GROUP BY f.lang`
  );
  const resByLang = new Map(resolution.map((r) => [r.lang, r]));

  const unresolvedByLang = new Map(
    store.all(
      `SELECT f.lang, COUNT(*) n FROM unresolved u JOIN files f ON f.id = u.file_id GROUP BY f.lang`
    ).map((r) => [r.lang, r.n])
  );

  const skips = store.all(
    `SELECT skip_reason, COUNT(*) n FROM files
      WHERE skip_reason IS NOT NULL GROUP BY skip_reason ORDER BY n DESC`
  );

  const unresolvedImports = store.get(
    `SELECT COUNT(*) n FROM imports WHERE resolved_file_id IS NULL AND external_id IS NULL`
  ).n;
  const totalImports = store.get('SELECT COUNT(*) n FROM imports').n;

  const topUnresolved = store.all(
    `SELECT name, COUNT(*) n FROM unresolved GROUP BY name ORDER BY n DESC LIMIT 10`
  );

  let gaps = [];
  try {
    const registry = await PackRegistry.load(config);
    gaps = registry.gaps();
    registry.dispose();
  } catch {
    // Pack loading problems are reported by index; doctor should still work.
  }

  const lastIndexed = Number(store.getMeta('last_indexed_at') ?? 0);

  return {
    root: config.root,
    stats,
    languages: byLang.map((l) => ({
      ...l,
      exact: resByLang.get(l.lang)?.exact ?? 0,
      inferred: resByLang.get(l.lang)?.inferred ?? 0,
      unresolved: unresolvedByLang.get(l.lang) ?? 0,
    })),
    skips,
    imports: { total: totalImports, unresolved: unresolvedImports },
    topUnresolved,
    gaps,
    grammars: {
      local: localGrammars().size,
      known: KNOWN_GRAMMARS.length,
      broken: KNOWN_GRAMMARS.filter((g) => grammarInfo(g).abiOk === false),
    },
    staleness: lastIndexed ? Date.now() - lastIndexed : null,
    counters: store.counters('total.'),
  };
}

function render(r) {
  out('');
  out(`${color.bold('cgraph doctor')}  ${r.root}`);

  // -- freshness
  out('');
  if (r.staleness === null) {
    out(color.yellow('  index has never been built — run `cgraph index`'));
  } else if (r.staleness > 24 * 3600 * 1000) {
    out(color.yellow(`  index is ${duration(r.staleness)} old — run \`cgraph update\``));
  } else {
    out(color.dim(`  index updated ${duration(r.staleness)} ago`));
  }

  // -- resolution quality, the headline number
  out('');
  out(color.bold('  resolution quality'));
  out(color.dim(`  ${pad('language', 12)} ${padLeft('files', 6)} ${padLeft('exact', 7)} ${padLeft('inferred', 9)} ${padLeft('unres', 7)}  quality`));

  for (const l of r.languages) {
    const total = l.exact + l.inferred + l.unresolved;
    if (!total && !l.parsed) continue;
    const pct = total ? Math.round((l.exact / total) * 100) : 0;
    const bar = qualityBar(pct, l.parsed);
    out(`  ${pad(l.lang, 12)} ${padLeft(l.files, 6)} ${padLeft(l.exact, 7)} ${padLeft(l.inferred, 9)} ${padLeft(l.unresolved, 7)}  ${bar}`);
  }

  // -- imports: the single biggest lever on resolution quality
  if (r.imports.total) {
    const resolvedPct = Math.round(((r.imports.total - r.imports.unresolved) / r.imports.total) * 100);
    out('');
    out(`  imports resolved: ${resolvedPct}% (${r.imports.unresolved} of ${r.imports.total} unresolved)`);
    if (resolvedPct < 80) {
      out(color.yellow('  low import resolution caps how many edges can ever be EXACT'));
    }
  }

  // -- coverage gaps
  if (r.gaps.length) {
    out('');
    out(color.yellow(`  languages without extraction queries: ${r.gaps.join(', ')}`));
    out(color.dim('  files in these languages appear in map but contribute no symbols'));
  }

  if (r.grammars.broken.length) {
    out(color.dim(`  grammars unusable with the pinned runtime: ${r.grammars.broken.join(', ')}`));
  }

  // -- skipped files
  if (r.skips.length) {
    out('');
    out(color.dim('  skipped files'));
    for (const s of r.skips) out(`    ${pad(s.skip_reason, 16)} ${padLeft(s.n, 6)}`);
  }

  // -- what is failing to resolve
  if (r.topUnresolved.length) {
    out('');
    out(color.dim('  most common unresolved names'));
    for (const u of r.topUnresolved.slice(0, 8)) {
      out(`    ${padLeft(u.n, 5)}  ${u.name}`);
    }
    out(color.dim('  (repeated names here usually mean a missing builtin list or import form)'));
  }

  // -- savings
  const saved = Number(r.counters['total.tokens_saved'] ?? 0);
  if (saved > 0) {
    const returned = Number(r.counters['total.tokens_returned'] ?? 0);
    const baseline = Number(r.counters['total.tokens_baseline'] ?? 0);
    const factor = returned > 0 ? (baseline / returned).toFixed(1) : '—';
    out('');
    out(`  tokens saved: ${saved.toLocaleString()}  (${factor}x reduction across ${r.counters['total.tokens_returned'] ? 'all queries' : 'none'})`);
  }

  out('');
}

/**
 * A quality verdict, not just a number. The thresholds encode what the split
 * actually means for whether an agent can trust the graph unverified.
 */
function qualityBar(pct, parsed) {
  if (!parsed) return color.dim('not parsed');
  if (pct >= 85) return color.green(`${pct}% proven`);
  if (pct >= 60) return color.yellow(`${pct}% proven`);
  return color.red(`${pct}% proven`);
}

function help() {
  out(`
${color.bold('cgraph doctor')} — index health, resolution quality, coverage gaps

  Reports what fraction of edges are proven vs guessed, per language, so
  regressions in resolution are visible rather than silent.

${color.bold('OPTIONS')}
  --json   Machine-readable report
`);
}
