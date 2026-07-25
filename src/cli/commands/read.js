/**
 * `cgraph read` — exact code slice. Replaces whole-file reads.
 */

import { loadConfig } from '../../core/config.js';
import { Store } from '../../core/store.js';
import { findSymbol, readSymbol } from '../../core/retrieve.js';
import { UsageLedger } from '../../core/tokens.js';
import { out, json, color, toks } from '../ui.js';

export async function run(args) {
  if (args.help) return help();

  const query = args._[0] ?? args.symbol;
  if (!query) throw new Error('read: give a symbol name or path:line-range');

  const config = loadConfig(process.cwd(), args.root ? { root: args.root } : {});
  const store = await Store.open(config.db, { create: false });

  try {
    const budget = args.budget ?? config.defaultBudget;
    const mode = args.mode ?? 'body';

    const range = parseLocation(query);
    const result = range
      ? readRange(store, config.root, range, budget)
      : readByName(store, config.root, query, { mode, budget, all: args.all });

    if (!result) {
      throw new Error(
        `No symbol or file matching '${query}'.\n` +
          "Try `cgraph find` to search, or check the path is repo-relative."
      );
    }

    new UsageLedger(store).record('read', result.tokens, result.baseline);

    if (args.json) return json(result);
    for (const line of result.lines) out(line);

    if (!args.quiet) {
      // Both numbers measured; the difference is not labelled a saving, because
      // that would assume reading the whole file was the alternative.
      out('');
      out(color.dim(
        `~${result.tokens} tokens` + (result.baseline ? `  ·  file ~${toks(result.baseline)}` : '')
      ));
    }
  } finally {
    store.close();
  }
}

/** `src/a.ts:10-40`, `src/a.ts:10`, or null when the input is a symbol name. */
function parseLocation(q) {
  const m = q.match(/^(.+?):(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  return {
    path: m[1].replace(/\\/g, '/'),
    start: Number(m[2]),
    end: m[3] ? Number(m[3]) : Number(m[2]),
  };
}

function readRange(store, root, range, budget) {
  const file = store.getFileByPath(range.path);
  if (!file) return null;

  // Synthesize a node so the same renderer handles both entry points.
  const pseudo = {
    file_id: file.id,
    kind: 'lines',
    name: `${range.start}-${range.end}`,
    start_line: range.start,
    end_line: range.end,
    start_byte: 0,
    end_byte: Number.MAX_SAFE_INTEGER, // forces the line-based path
    doc: null,
    signature: null,
  };
  return readSymbol(store, root, pseudo, { mode: 'body', budget });
}

function readByName(store, root, query, { mode, budget, all }) {
  const matches = findSymbol(store, query, { limit: all ? 25 : 10 });
  if (!matches.length) return null;

  // Ambiguity is information. Listing the candidates costs ~15 tokens each and
  // lets the agent pick, which beats silently returning the wrong `handler`.
  if (matches.length > 1 && !all) {
    const best = matches[0];
    const rest = matches.slice(1);
    const result = readSymbol(store, root, best, { mode, budget });
    result.lines.push('');
    result.lines.push(`${rest.length} other match${rest.length > 1 ? 'es' : ''}:`);
    for (const m of rest.slice(0, 8)) {
      result.lines.push(`  ${m.qname}  ${m.path}:${m.start_line}`);
    }
    return result;
  }

  return readSymbol(store, root, matches[0], { mode, budget });
}

function help() {
  out(`
${color.bold('cgraph read')} — read exactly one symbol or line range

  cgraph read LoginService#login     By qualified name
  cgraph read login                  By bare name (lists other matches)
  cgraph read src/auth.ts:20-40      By location

${color.bold('OPTIONS')}
  --mode <m>    signature | body  (default body)
  --all         Show every match rather than the best one
  --budget <n>  Cap the response in tokens
  --json        Machine-readable output
`);
}
