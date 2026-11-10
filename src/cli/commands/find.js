/**
 * `cgraph find` — ranked code search. Replaces grep.
 */

import { loadConfig } from '../../core/config.js';
import { Store } from '../../core/store.js';
import { search, renderHits } from '../../core/search.js';
import { find } from '../../core/find.js';
import { UsageLedger } from '../../core/tokens.js';
import { fitToBudget } from '../../core/tokens.js';
import { out, json, color } from '../ui.js';

export async function run(args) {
  if (args.help) return help();

  const query = args._.join(' ') || args.query;
  if (!query) throw new Error('find: give a search query');

  const config = loadConfig(process.cwd(), args.root ? { root: args.root } : {});
  const store = await Store.open(config.db, { create: false });

  try {
    const filters = {
      kind: args.kind ?? null,
      lang: args.lang ?? null,
      path: args.path ?? null,
      limit: args.limit,
    };

    if (args.json) {
      const hits = search(store, query, filters);
      return json(hits.map((h) => ({
        qname: h.node.qname, path: h.node.path, line: h.node.start_line,
        endLine: h.node.end_line,
        kind: h.node.kind, signature: h.node.signature, rank: h.node.rank,
        score: h.final, why: h.why, subproject: h.node.subproject,
        skipReason: h.node.skipReason,
      })));
    }

    const answer = await find(store, config, { query, ...filters });

    if (answer.mode === 'none') {
      // A miss is still an answer: the closest real names, or the filter that
      // excluded everything. Never a bare "nothing found".
      const [first, ...rest] = answer.lines;
      out(first);
      for (const line of rest) out(color.dim(line));
      return;
    }

    const lines = args.verbose && answer.mode === 'symbols'
      ? renderHits(answer.hits, { showWhy: true })
      : answer.lines;
    const budget = args.budget ?? config.defaultBudget;
    const fitted = fitToBudget(lines, budget);

    for (const line of fitted.lines) out(line);
    if (fitted.dropped) out(color.dim(`... ${fitted.dropped} more lines (raise --budget)`));

    // No source figure: a search spans many files, and there is no honest way
    // to say how much of them another workflow would have read.
    new UsageLedger(store).record('find', fitted.tokens);

    if (!args.quiet) {
      out('');
      const what = answer.mode === 'text' ? 'text matches' : `${answer.hits.length} hits`;
      out(color.dim(`${what}  ·  ~${fitted.tokens} tokens`));
    }
  } finally {
    store.close();
  }
}

function help() {
  out(`
${color.bold('cgraph find')} — search code by name, by description, or by literal text

  cgraph find login              Anything named like 'login'
  cgraph find parse config file  Describe it: names, docs and function bodies
  cgraph find '"parse error"'    Quoted: literal text, grouped by enclosing symbol
  cgraph find handler --kind function
  cgraph find User --path src/models

  A query that matches no symbol is tried as literal text before giving up.

${color.bold('OPTIONS')}
  --kind <k>     class | interface | function | method | field | var | const | type
  --lang <l>     Filter by language
  --path <p>     Filter by path prefix
  --limit <n>    Maximum hits (default: up to 12, weak matches left out)
  --budget <n>   Cap the response in tokens
  --verbose      Show why each result matched
  --json         Machine-readable output
`);
}
