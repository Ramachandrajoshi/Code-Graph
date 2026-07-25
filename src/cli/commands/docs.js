/**
 * `cgraph docs` — dependency API, ranked by what this project actually uses.
 */

import { loadConfig } from '../../core/config.js';
import { Store } from '../../core/store.js';
import { lookupDocs, listDependencies } from '../../deps/lookup.js';
import { extractAllDocs } from '../../deps/extract.js';
import { out, json, color, pad, padLeft, Progress } from '../ui.js';

export async function run(args) {
  if (args.help) return help();

  const config = loadConfig(process.cwd(), args.root ? { root: args.root } : {});
  const store = await Store.open(config.db, { create: false });

  try {
    // `--refresh` reads signatures out of node_modules / site-packages. Kept
    // opt-in because it is the only part of the tool that may touch the network.
    if (args.refresh) {
      const progress = new Progress('  reading', { quiet: args.quiet });
      const result = await extractAllDocs(store, config, {
        offline: args.offline ?? config.deps.offline,
        onProgress: (pkg) => progress.tick(1, pkg),
      });
      progress.done();
      out(`  ${result.packages} packages, ${result.symbols} symbols documented` +
          (result.failed ? color.dim(`, ${result.failed} unavailable`) : ''));
      out('');
    }

    const pkg = args._[0] ?? args.package;

    if (!pkg) {
      const deps = listDependencies(store, { limit: args.limit ?? 30 });
      if (args.json) return json(deps);

      if (!deps.length) {
        out('no dependency usage recorded — run `cgraph index` first');
        return;
      }
      out('');
      out(color.bold('dependencies by usage in this repo'));
      out('');
      let inStdlib = false;
      for (const d of deps) {
        if (d.stdlib && !inStdlib) {
          inStdlib = true;
          out(color.dim('  — standard library —'));
        }
        out(`  ${padLeft(d.uses, 6)}  ${pad(d.package, 28)} ${color.dim(`${d.symbols} symbols  ${d.ecosystem}`)}`);
      }
      out('');
      out(color.dim('  cgraph docs <package>   to see the API this project uses'));
      out('');
      return;
    }

    const result = lookupDocs(store, config, {
      pkg, symbol: args.symbol ?? args._[1] ?? null, top: args.top ?? 15,
    });

    if (args.json) return json(result);
    out('');
    for (const line of result.lines) out(line);
    out('');
  } finally {
    store.close();
  }
}

function help() {
  out(`
${color.bold('cgraph docs')} — dependency API, ranked by what this project calls

  cgraph docs                    All dependencies by usage
  cgraph docs express            The Express API this repo uses
  cgraph docs express Router     One specific export
  cgraph docs --refresh          Read signatures from node_modules / registry

${color.bold('OPTIONS')}
  --refresh      Extract signatures now (local first, registry as fallback)
  --offline      With --refresh, never touch the network
  --top <n>      Symbols per package (default 15)
  --json         Machine-readable output
`);
}
