/**
 * `cgraph map` — hierarchical outline. Replaces ls, glob, and exploratory reads.
 */

import { loadConfig } from '../../core/config.js';
import { Store } from '../../core/store.js';
import { outlineFile, outlineDir } from '../../core/retrieve.js';
import { SavingsLedger } from '../../core/tokens.js';
import { out, json, color } from '../ui.js';

export async function run(args) {
  if (args.help) return help();

  const config = loadConfig(process.cwd(), args.root ? { root: args.root } : {});
  const store = await Store.open(config.db, { create: false });

  try {
    const target = normalize(args._[0] ?? args.path ?? '');
    const budget = args.budget ?? config.defaultBudget;
    const kinds = args.kind ? args.kind.split(',').map((k) => k.trim()) : null;

    const file = target ? store.getFileByPath(target) : null;
    const result = file
      ? outlineFile(store, file, { budget, kinds, maxDepth: args.depth ?? 99 })
      : outlineDir(store, target, { depth: args.depth ?? 1, budget });

    new SavingsLedger(store).record('map', result.tokens, result.baseline);

    if (args.json) {
      return json({
        target: target || '.',
        lines: result.lines,
        tokens: result.tokens,
        baseline: result.baseline,
        dropped: result.dropped,
      });
    }

    for (const line of result.lines) out(line);

    if (!args.quiet) {
      const saved = Math.max(0, result.baseline - result.tokens);
      out('');
      out(color.dim(
        `~${result.tokens} tokens` +
          (saved ? `  ·  ${saved} saved vs reading ${file ? 'this file' : 'these files'}` : '')
      ));
    }
  } finally {
    store.close();
  }
}

/** Accept `./src`, `src/`, and native backslash paths alike. */
function normalize(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function help() {
  out(`
${color.bold('cgraph map')} — outline the repo, a directory, or a file

  cgraph map                  Top-level directory breakdown
  cgraph map src              Contents of src/
  cgraph map src/auth/login.ts  Symbol outline for one file

${color.bold('OPTIONS')}
  --depth <n>     Directory levels to expand (default 1)
  --kind <list>   Only these kinds, e.g. class,function
  --budget <n>    Cap the response in tokens
  --json          Machine-readable output
`);
}
