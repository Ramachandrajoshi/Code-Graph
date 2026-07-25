/**
 * MCP server.
 *
 * Binds the seven tools to the retrieval layer. Two behaviours matter here
 * beyond plumbing:
 *
 *   1. Staleness is handled, not assumed away. An agent that trusts a stale
 *      index makes confident wrong edits, so `status` refreshes and every tool
 *      can report when the index has drifted.
 *   2. Errors return as readable tool results rather than protocol errors.
 *      A model can act on "no symbol named X, try find" — it cannot act on a
 *      JSON-RPC error code.
 */

import { StdioServer, textResult, errorResult } from './protocol.js';
import { toolDefinitions } from './tools.js';
import { Store } from '../core/store.js';
import { loadConfig } from '../core/config.js';
import { outlineFile, outlineDir, findSymbol, readSymbol } from '../core/retrieve.js';
import { search, renderHits } from '../core/search.js';
import { callers, callees, importers, impact, shortestPath, hydrate } from '../core/graph.js';
import { degree } from '../core/rank.js';
import { SavingsLedger, fitToBudget } from '../core/tokens.js';
import { lookupDocs, listDependencies } from '../deps/lookup.js';

export async function createServer({ root, version }) {
  const config = loadConfig(root ?? process.cwd(), root ? { root } : {});
  const store = await Store.open(config.db, { create: false });
  const ledger = new SavingsLedger(store);

  const handlers = {
    async listTools() {
      return toolDefinitions({ embeddingsEnabled: config.embeddings?.enabled });
    },

    async callTool(name, args) {
      try {
        switch (name) {
          case 'map':    return toolMap(store, config, args, ledger);
          case 'find':   return toolFind(store, config, args, ledger);
          case 'read':   return toolRead(store, config, args, ledger);
          case 'graph':  return toolGraph(store, config, args, ledger);
          case 'docs':   return toolDocs(store, config, args);
          case 'status': return await toolStatus(store, config, args);
          case 'similar': return await toolSimilar(store, config, args);
          default:
            return errorResult(`Unknown tool '${name}'.`);
        }
      } catch (err) {
        return errorResult(`${name} failed: ${err.message}`);
      }
    },
  };

  const server = new StdioServer({ name: 'code-graph', version, handlers });
  return { server, store, config };
}

// ---------------------------------------------------------------- tools

function budgetOf(config, args) {
  return args.budget ?? config.defaultBudget;
}

function toolMap(store, config, args, ledger) {
  const target = normalizePath(args.path ?? '');
  const file = target ? store.getFileByPath(target) : null;

  const result = file
    ? outlineFile(store, file, { budget: budgetOf(config, args), kinds: args.kinds ?? null, maxDepth: args.depth ?? 99 })
    : outlineDir(store, target, { depth: args.depth ?? 1, budget: budgetOf(config, args) });

  // A path that is neither a file nor a directory prefix is usually a wrong
  // guess at the layout. Saying so, and offering the parent, is cheaper than
  // letting the agent probe three more times.
  if (!file && result.lines[0]?.startsWith('no indexed files')) {
    const parent = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
    const alt = outlineDir(store, parent, { depth: 1, budget: budgetOf(config, args) });
    return textResult(
      `No file or directory '${target}'.\n\nNearest indexed level (${parent || '.'}):\n` +
        alt.lines.join('\n')
    );
  }

  ledger.record('map', result.tokens, result.baseline);
  return textResult(result.lines.join('\n') + staleness(store));
}

function toolFind(store, config, args, ledger) {
  const hits = search(store, args.query, {
    kind: args.kind ?? null,
    lang: args.lang ?? null,
    path: args.path ? normalizePath(args.path) : null,
    limit: args.limit ?? 20,
  });

  if (!hits.length) {
    return textResult(
      `No symbols matching '${args.query}'.\n` +
        'The symbol may be defined dynamically, live in a language with no extraction ' +
        'queries yet, or the index may be stale — call status to check.'
    );
  }

  const fitted = fitToBudget(renderHits(hits), budgetOf(config, args));
  const baseline = grepBaseline(store, hits);
  ledger.record('find', fitted.tokens, baseline);

  let text = fitted.lines.join('\n');
  if (fitted.dropped) text += `\n... ${fitted.dropped} more lines (raise budget)`;
  return textResult(text + staleness(store));
}

function toolRead(store, config, args, ledger) {
  const target = String(args.target);
  const budget = budgetOf(config, args);
  const range = parseLocation(target);

  if (range) {
    const file = store.getFileByPath(range.path);
    if (!file) return errorResult(`No indexed file '${range.path}'.`);
    const pseudo = {
      file_id: file.id, kind: 'lines', name: `${range.start}-${range.end}`,
      start_line: range.start, end_line: range.end,
      start_byte: 0, end_byte: Number.MAX_SAFE_INTEGER, doc: null, signature: null,
    };
    const result = readSymbol(store, store.getMeta('root'), pseudo, { mode: 'body', budget });
    ledger.record('read', result.tokens, result.baseline);
    return textResult(result.lines.join('\n'));
  }

  const matches = findSymbol(store, target, { limit: 10 });
  if (!matches.length) {
    return errorResult(`No symbol named '${target}'. Use find to search for it.`);
  }

  const result = readSymbol(store, store.getMeta('root'), matches[0], {
    mode: args.mode ?? 'body', budget,
  });

  // Ambiguity is information the agent needs. Listing alternatives costs ~15
  // tokens each and prevents acting on the wrong `handler`.
  if (matches.length > 1) {
    result.lines.push('', `${matches.length - 1} other symbols share this name:`);
    for (const m of matches.slice(1, 6)) {
      result.lines.push(`  ${m.qname}  ${m.path}:${m.start_line}`);
    }
  }

  ledger.record('read', result.tokens, result.baseline);
  return textResult(result.lines.join('\n') + staleness(store));
}

function toolGraph(store, config, args, ledger) {
  const direction = args.direction ?? 'callers';
  const matches = findSymbol(store, args.symbol, { limit: 3 });
  if (!matches.length) {
    return errorResult(`No symbol named '${args.symbol}'. Use find to search for it.`);
  }
  const node = matches[0];
  const lines = [];

  if (direction === 'callers') {
    const rows = callers(store, node.id, { limit: 60, minConfidence: args.exact ? 'EXACT' : null });
    const d = degree(store, node.id);
    lines.push(`${node.qname}  ${node.path}:${node.start_line}`, `callers: ${d.callers}  callees: ${d.callees}`, '');
    if (!rows.length) lines.push('(no callers — entry point, dead code, or called dynamically)');
    for (const r of rows) {
      lines.push(`${r.confidence === 'EXACT' ? ' ' : '!'} ${r.qname}  ${r.path}:${r.line}${r.sites > 1 ? ` (${r.sites}x)` : ''}`);
    }
  } else if (direction === 'callees') {
    const { internal, external } = callees(store, node.id, { limit: 60 });
    lines.push(`${node.qname} calls:`, '');
    for (const r of internal) lines.push(`${r.confidence === 'EXACT' ? ' ' : '!'} ${r.qname}  ${r.path}:${r.start_line}`);
    if (external.length) {
      lines.push('', 'external:');
      for (const r of external) lines.push(`  ${r.package}${r.symbol ? '.' + r.symbol : ''} (${r.ecosystem})`);
    }
    if (!internal.length && !external.length) lines.push('(calls nothing this index knows about)');
  } else if (direction === 'importers') {
    const file = store.get('SELECT * FROM files WHERE id = ?', node.file_id);
    const rows = importers(store, file.id);
    lines.push(`files importing ${file.path}:`, '');
    if (!rows.length) lines.push('(nothing imports this file)');
    for (const r of rows) lines.push(`  ${r.path}:${r.line}  ${r.symbol ?? r.spec}`);
  } else if (direction === 'impact') {
    const result = impact(store, node.id, { depth: args.depth ?? 3, limit: 200, minConfidence: args.exact ? 'EXACT' : null });
    lines.push(`impact of changing ${node.qname}: ${result.nodes.length} symbols`, '');
    let d = 0;
    for (const r of result.nodes) {
      if (r.distance !== d) { d = r.distance; lines.push(`${d === 1 ? 'direct' : d + ' hops'}:`); }
      lines.push(`${r.confidence === 'EXACT' ? ' ' : '!'} ${r.qname}  ${r.path}:${r.start_line}`);
    }
    if (result.truncated) lines.push('', '(truncated — this symbol is central)');
  } else if (direction === 'path') {
    if (!args.to) return errorResult('direction="path" requires a `to` symbol.');
    const destMatches = findSymbol(store, args.to, { limit: 1 });
    if (!destMatches.length) return errorResult(`No symbol named '${args.to}'.`);
    const ids = shortestPath(store, node.id, destMatches[0].id, { maxDepth: args.depth ?? 8 });
    if (!ids) {
      lines.push(`No call path from ${node.qname} to ${destMatches[0].qname}.`);
    } else {
      const rows = hydrate(store, ids);
      lines.push(`${rows.length - 1} hops:`, '');
      rows.forEach((r, i) => lines.push(`  ${i === 0 ? ' ' : '->'} ${r.qname}  ${r.path}:${r.start_line}`));
    }
  } else {
    return errorResult(`Unknown direction '${direction}'. Use callers, callees, importers, impact, or path.`);
  }

  const fitted = fitToBudget(lines, budgetOf(config, args));
  ledger.record('graph', fitted.tokens, 0);
  let text = fitted.lines.join('\n');
  if (fitted.dropped) text += `\n... ${fitted.dropped} more (raise budget)`;
  return textResult(text + staleness(store));
}

function toolDocs(store, config, args) {
  if (!args.package) {
    const deps = listDependencies(store, { limit: args.top ?? 25 });
    if (!deps.length) {
      return textResult('No dependency usage recorded. Run `cgraph index` to populate it.');
    }
    const lines = ['dependencies by usage in this repo:', ''];
    for (const d of deps) lines.push(`  ${String(d.uses).padStart(5)}  ${d.package}  (${d.ecosystem})`);
    return textResult(lines.join('\n'));
  }

  const result = lookupDocs(store, config, {
    pkg: args.package, symbol: args.symbol ?? null, top: args.top ?? 15,
  });
  return textResult(result.lines.join('\n'));
}

async function toolStatus(store, config, args) {
  const refresh = args.refresh !== false;
  const lines = [];

  if (refresh) {
    const { Indexer } = await import('../core/indexer.js');
    const { PackRegistry } = await import('../packs/registry.js');
    const registry = await PackRegistry.load(config);
    const stats = await new Indexer({ store, config, registry }).run({});
    registry.dispose();

    if (stats.added || stats.changed || stats.removed) {
      lines.push(`refreshed: ${stats.added} added, ${stats.changed} changed, ${stats.removed} removed`);
    } else {
      lines.push('index is up to date');
    }
  }

  const s = store.stats();
  const total = s.exact + s.inferred;
  lines.push(
    '',
    `files    ${s.files} (${s.parsed} with symbols)`,
    `symbols  ${s.nodes}`,
    `edges    ${s.edges}  (${total ? Math.round((s.exact / total) * 100) : 0}% proven, ${s.inferred} inferred)`,
    `deps     ${s.externals}`,
  );

  const counters = store.counters('total.');
  const saved = Number(counters['total.tokens_saved'] ?? 0);
  if (saved > 0) lines.push('', `tokens saved so far: ${saved.toLocaleString()}`);

  return textResult(lines.join('\n'));
}

async function toolSimilar(store, config, args) {
  if (!config.embeddings?.enabled) {
    return errorResult(
      'Semantic search is not configured. Enable embeddings in .codegraph/config.json, ' +
        'then run `cgraph index --embed`. Structural search via find usually answers ' +
        'the same question for free.'
    );
  }

  // Loaded lazily so a server without embeddings configured never pays for it.
  const { semanticSearch } = await import('../embed/index.js');
  const hits = await semanticSearch(store, config, args.query, { limit: args.limit ?? 10 });

  const lines = hits.map(
    (h, i) => `${String(i + 1).padStart(2)} ${h.qname}  ${h.path}:${h.start_line}  ${h.score.toFixed(3)}`
  );
  return textResult(lines.join('\n') || 'no matches');
}

// ---------------------------------------------------------------- helpers

/**
 * A short staleness note, appended to answers when the index has drifted.
 *
 * Silence here is dangerous: an agent has no other way to know the code moved
 * under it, and a confidently wrong line number wastes far more than the ~12
 * tokens this costs.
 */
function staleness(store) {
  const last = Number(store.getMeta('last_indexed_at') ?? 0);
  if (!last) return '';
  const ageMin = (Date.now() - last) / 60000;
  if (ageMin < 10) return '';
  return `\n\n(index last updated ${Math.round(ageMin)} min ago — call status to refresh)`;
}

function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function parseLocation(q) {
  const m = q.match(/^(.+?):(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  return { path: normalizePath(m[1]), start: Number(m[2]), end: m[3] ? Number(m[3]) : Number(m[2]) };
}

function grepBaseline(store, hits) {
  const paths = [...new Set(hits.map((h) => h.node.path))];
  if (!paths.length) return 0;
  const holes = paths.map(() => '?').join(',');
  return store.get(`SELECT COALESCE(SUM(tok),0) n FROM files WHERE path IN (${holes})`, ...paths).n;
}
