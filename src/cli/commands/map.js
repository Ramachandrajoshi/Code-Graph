/**
 * `cgraph map` — hierarchical outline. Replaces ls, glob, and exploratory reads.
 */

import { loadConfig } from '../../core/config.js';
import { Store } from '../../core/store.js';
import { outlineFile, outlineDir } from '../../core/retrieve.js';
import { UsageLedger } from '../../core/tokens.js';
import { out, json, color, toks } from '../ui.js';

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

    new UsageLedger(store).record('map', result.tokens, result.baseline);

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
      // Two measured numbers, stated as facts. Calling the difference "saved"
      // would assert that reading the file was the alternative, which is a
      // claim about your workflow that this tool is in no position to make.
      out('');
      out(color.dim(
        `~${result.tokens} tokens` +
          (result.baseline ? `  ·  ${file ? 'file' : 'these files'} ~${toks(result.baseline)}` : '')
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
