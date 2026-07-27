/**
 * `cgraph find` — ranked symbol search. Replaces grep.
 */

import { loadConfig } from '../../core/config.js';
import { Store } from '../../core/store.js';
import { search, renderHits } from '../../core/search.js';
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
    const hits = search(store, query, {
      kind: args.kind ?? null,
      lang: args.lang ?? null,
      path: args.path ?? null,
      limit: args.limit ?? 20,
    });

    if (args.json) {
      return json(hits.map((h) => ({
        qname: h.node.qname, path: h.node.path, line: h.node.start_line,
        kind: h.node.kind, signature: h.node.signature, rank: h.node.rank,
        score: h.final, why: h.why, subproject: h.node.subproject,
      })));
    }

    if (!hits.length) {
      out(`no symbols matching '${query}'`);
      // A miss is worth two lines of guidance: the most common cause is a stale
      // index, and the agent has no other way to know that.
      out(color.dim('try `cgraph update` if the code changed, or a shorter query'));
      return;
    }

    const lines = renderHits(hits, { showWhy: args.verbose });
    const budget = args.budget ?? config.defaultBudget;
    const fitted = fitToBudget(lines, budget);

    for (const line of fitted.lines) out(line);
    if (fitted.dropped) out(color.dim(`... ${fitted.dropped} more lines (raise --budget)`));

    // No source figure: a search spans many files, and there is no honest way
    // to say how much of them another workflow would have read.
    new UsageLedger(store).record('find', fitted.tokens);

    if (!args.quiet) {
      out('');
      out(color.dim(`${hits.length} hits  ·  ~${fitted.tokens} tokens`));
    }
  } finally {
    store.close();
  }
}

function help() {
  out(`
${color.bold('cgraph find')} — search symbols by name, signature or doc text

  cgraph find login              Anything matching 'login'
  cgraph find "parse config"     Multi-word search across docs
  cgraph find handler --kind function
  cgraph find User --path src/models

${color.bold('OPTIONS')}
  --kind <k>     class | interface | function | method | field | var | const | type
  --lang <l>     Filter by language
  --path <p>     Filter by path prefix
  --limit <n>    Maximum hits (default 20)
  --budget <n>   Cap the response in tokens
  --verbose      Show why each result matched
  --json         Machine-readable output
`);
}
