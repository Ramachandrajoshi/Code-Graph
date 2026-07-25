/**
 * `cgraph stats` — index size and what queries have actually cost.
 *
 * Reports measured response sizes only. It deliberately does not compute a
 * savings multiplier: doing so requires assuming what a different workflow
 * would have spent, and that assumption — not the measurement — determines the
 * answer. Where a concrete comparable exists (the file an outline describes)
 * both numbers are shown and the reader can draw their own conclusion.
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
    const source = Number(counters['total.tokens_source'] ?? 0);

    out('');
    if (!returned) {
      out(color.dim('  no queries recorded yet — run map, find, read or graph'));
      out('');
      return;
    }

    out(color.bold('  query cost'));
    out(`  ${pad('returned', 12)} ${padLeft(toks(returned), 8)}  ${color.dim('tokens these queries actually cost')}`);
    if (source) {
      out(`  ${pad('files read', 12)} ${padLeft(toks(source), 8)}  ${color.dim('size of the files those answers came from')}`);
    }

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
      out(color.dim(`  ${pad('tool', 10)} ${padLeft('calls', 7)} ${padLeft('returned', 10)} ${padLeft('avg', 8)}`));
      for (const [name, t] of [...tools].sort((a, b) => (b[1].calls ?? 0) - (a[1].calls ?? 0))) {
        const avg = t.calls ? Math.round((t.tokens_returned ?? 0) / t.calls) : 0;
        out(`  ${pad(name, 10)} ${padLeft(t.calls ?? 0, 7)} ${padLeft(toks(t.tokens_returned ?? 0), 10)} ${padLeft(toks(avg), 8)}`);
      }
    }

    out('');
  } finally {
    store.close();
  }
}

function help() {
  out(`
${color.bold('cgraph stats')} — index size and what queries have cost

${color.bold('OPTIONS')}
  --json   Machine-readable output
`);
}
