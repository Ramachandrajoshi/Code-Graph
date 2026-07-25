/**
 * `cgraph stats` — index size and the token savings ledger.
 *
 * The savings number is the product's central claim, so it is measured
 * continuously from real usage rather than asserted once in a README.
 */

import { loadConfig } from '../../core/config.js';
import { Store } from '../../core/store.js';
import { out, json, color, pad, padLeft, toks } from '../ui.js';

export async function run(args) {
  if (args.help) return help();

  const config = loadConfig(process.cwd(), args.root ? { root: args.root } : {});
  const store = await Store.open(config.db, { create: false });

  try {
    const s = store.stats();
    const counters = store.counters();

    if (args.json) return json({ stats: s, counters });

    const total = s.exact + s.inferred;
    out('');
    out(`${color.bold('index')}  ${config.root}`);
    out('');
    out(`  ${pad('files', 12)} ${padLeft(s.files, 8)}  ${color.dim(`${s.parsed} with symbols`)}`);
    out(`  ${pad('symbols', 12)} ${padLeft(s.nodes, 8)}`);
    out(`  ${pad('edges', 12)} ${padLeft(s.edges, 8)}  ${color.dim(`${total ? Math.round((s.exact / total) * 100) : 0}% proven`)}`);
    out(`  ${pad('dependencies', 12)} ${padLeft(s.externals, 8)}`);
    out(`  ${pad('lines', 12)} ${padLeft(s.loc.toLocaleString(), 8)}`);
    out(`  ${pad('source', 12)} ${padLeft('~' + toks(s.tok), 8)}  ${color.dim('tokens to read it all')}`);

    const returned = Number(counters['total.tokens_returned'] ?? 0);
    const baseline = Number(counters['total.tokens_baseline'] ?? 0);
    const saved = Number(counters['total.tokens_saved'] ?? 0);

    out('');
    if (!returned) {
      out(color.dim('  no queries recorded yet — run map, find, read or graph'));
      out('');
      return;
    }

    out(color.bold('  token savings'));
    out(`  ${pad('returned', 12)} ${padLeft(toks(returned), 8)}  ${color.dim('what queries actually cost')}`);
    out(`  ${pad('baseline', 12)} ${padLeft(toks(baseline), 8)}  ${color.dim('what reading the files would have cost')}`);
    out(`  ${pad('saved', 12)} ${padLeft(toks(saved), 8)}  ${color.green(`${(baseline / returned).toFixed(1)}x reduction`)}`);

    // Per-tool breakdown, so it is obvious which access pattern pays off most.
    const tools = new Map();
    for (const [key, value] of Object.entries(counters)) {
      const m = key.match(/^tool\.(\w+)\.(\w+)$/);
      if (!m) continue;
      const entry = tools.get(m[1]) ?? {};
      entry[m[2]] = Number(value);
      tools.set(m[1], entry);
    }

    if (tools.size) {
      out('');
      out(color.dim(`  ${pad('tool', 10)} ${padLeft('calls', 7)} ${padLeft('returned', 10)} ${padLeft('baseline', 10)}  factor`));
      for (const [name, t] of [...tools].sort((a, b) => (b[1].calls ?? 0) - (a[1].calls ?? 0))) {
        const factor = t.tokens_returned ? (t.tokens_baseline / t.tokens_returned).toFixed(1) + 'x' : '—';
        out(`  ${pad(name, 10)} ${padLeft(t.calls ?? 0, 7)} ${padLeft(toks(t.tokens_returned ?? 0), 10)} ${padLeft(toks(t.tokens_baseline ?? 0), 10)}  ${factor}`);
      }
    }

    out('');
  } finally {
    store.close();
  }
}

function help() {
  out(`
${color.bold('cgraph stats')} — index size and cumulative token savings

${color.bold('OPTIONS')}
  --json   Machine-readable output
`);
}
