/**
 * MCP server.
 *
 * Binds the tools to the retrieval layer. Two behaviours matter here beyond
 * plumbing:
 *
 *   1. Staleness is handled, not assumed away. An agent that trusts a stale
 *      index makes confident wrong edits, so every tool call triggers a
 *      throttled refresh first, and answers say when the index has drifted.
 *   2. Errors return as readable tool results rather than protocol errors.
 *      A model can act on "no symbol named X, try find" — it cannot act on a
 *      JSON-RPC error code.
 */

import { StdioServer, textResult, errorResult } from './protocol.js';
import { toolDefinitions } from './tools.js';
import { Store } from '../core/store.js';
import { loadConfig } from '../core/config.js';
import { outlineFile, outlineDir, findSymbol } from '../core/retrieve.js';
import { search, renderHits } from '../core/search.js';
import { callers, callees, importers, impact, shortestPath, hydrate } from '../core/graph.js';
import { degree } from '../core/rank.js';
import { UsageLedger, fitToBudget } from '../core/tokens.js';

export async function createServer({ root, version }) {
  const config = loadConfig(root ?? process.cwd(), root ? { root } : {});
  const store = await Store.open(config.db, { create: false });
  const ledger = new UsageLedger(store);
  const refresher = new Refresher(store, config);

  const handlers = {
    async listTools() {
      return toolDefinitions({ embeddingsEnabled: config.embeddings?.enabled });
    },

    async callTool(name, args) {
      try {
        // Refresh before answering, so the agent never reads a graph that
        // disagrees with the working tree.
        await refresher.maybe();

        switch (name) {
          case 'map':    return toolMap(store, config, args, ledger);
          case 'find':   return toolFind(store, config, args, ledger);
          case 'similar': return await toolSimilar(store, config, args);
          default:
            return errorResult(`Unknown tool '${name}'.`);
        }
      } catch (err) {
        return errorResult(`${name} failed: ${err.message}`);
      }
    },
  };

  const server = new StdioServer({ name: 'cgraph', version, handlers });
  return { server, store, config, refresher };
}

/**
 * Keeps the index current, cheaply, without a watcher process.
 *
 * The agent's own queries are the trigger. That is a better signal than a
 * timer: freshness is only needed at the moment of use, and a query is exactly
 * that moment. No daemon to start, nothing to remember, and correct after any
 * change — an editor save, a git checkout, a rebase, another agent's edit.
 *
 * Three properties make it affordable:
 *   - the scan is a stat per file, not a read (~170ms on 3,000 files)
 *   - it is throttled, so a burst of tool calls costs one scan
 *   - the pack registry is loaded once, not per refresh
 */
class Refresher {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.registry = null;
    this.lastCheck = 0;
    this.inFlight = null;
  }

  async maybe() {
    if (this.config.autoRefresh?.enabled === false) return null;

    // Concurrent tool calls share one refresh rather than racing to index the
    // same files into the same tables.
    if (this.inFlight) return this.inFlight;

    const throttle = this.config.autoRefresh?.throttleMs ?? 3000;
    if (Date.now() - this.lastCheck < throttle) return null;

    this.inFlight = this._run().finally(() => {
      this.lastCheck = Date.now();
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async _run() {
    try {
      const { Indexer } = await import('../core/indexer.js');
      const { PackRegistry } = await import('../packs/registry.js');
      this.registry ??= await PackRegistry.load(this.config);

      return await new Indexer({
        store: this.store, config: this.config, registry: this.registry,
      }).run({});
    } catch (err) {
      // A refresh failure must never take down a query. The agent gets the
      // previous index, which is worse than fresh but far better than an error,
      // and the reason is on stderr for a human to find.
      process.stderr.write(`[cgraph] refresh failed: ${err.message}\n`);
      return null;
    }
  }

  dispose() {
    this.registry?.dispose();
    this.registry = null;
  }
}

// ---------------------------------------------------------------- tools

// Unlike the CLI (where config.defaultBudget keeps terminal output sane by
// default), MCP responses are uncapped unless the caller passes `budget`
// explicitly. A model that gets a silently shortened answer treats it as
// complete and stops looking — that costs far more than the tokens a default
// cap would have saved.
function budgetOf(args) {
  return args.budget ?? null;
}

function toolMap(store, config, args, ledger) {
  // One tool, two modes: a symbol routes to relationships, a path (or nothing)
  // routes to a structural outline.
  if (args.symbol) return toolGraph(store, config, args, ledger);

  const target = normalizePath(args.path ?? '');
  const file = target ? store.getFileByPath(target) : null;

  const result = file
    ? outlineFile(store, file, { budget: budgetOf(args), kinds: args.kinds ?? null, maxDepth: args.depth ?? 99 })
    : outlineDir(store, target, { depth: args.depth ?? 1, budget: budgetOf(args) });

  // A path that is neither a file nor a directory prefix is usually a wrong
  // guess at the layout. Saying so, and offering the parent, is cheaper than
  // letting the agent probe three more times.
  if (!file && result.lines[0]?.startsWith('no indexed files')) {
    const parent = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
    const alt = outlineDir(store, parent, { depth: 1, budget: budgetOf(args) });
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
        'queries yet, or the index may be stale — run `cgraph update` to check.'
    );
  }

  const fitted = fitToBudget(renderHits(hits), budgetOf(args));
  // No source figure: a search spans many files, and there is no honest way
  // to say how much of them another workflow would have read.
  ledger.record('find', fitted.tokens);

  let text = fitted.lines.join('\n');
  if (fitted.dropped) text += `\n... ${fitted.dropped} more lines (raise budget)`;
  return textResult(text + staleness(store));
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
  } else if (direction === 'explore') {
    const d = degree(store, node.id);
    lines.push(`${node.qname}  ${node.path}:${node.start_line}-${node.end_line}`, '');

    const callerRows = callers(store, node.id, { limit: args.limit ?? 30, minConfidence: args.exact ? 'EXACT' : null });
    lines.push(`called from (bottom-up, ${d.callers}):`);
    if (!callerRows.length) lines.push('  (no callers — entry point, dead code, or called dynamically)');
    for (const r of callerRows) {
      lines.push(`${r.confidence === 'EXACT' ? ' ' : '!'} ${r.qname}  ${r.path}:${r.start_line}-${r.end_line}${r.sites > 1 ? ` (${r.sites}x)` : ''}`);
    }

    const { internal, external } = callees(store, node.id, { limit: args.limit ?? 30 });
    lines.push('', `calls (top-down, ${d.callees}):`);
    if (!internal.length && !external.length) lines.push('  (calls nothing this index knows about)');
    for (const r of internal) lines.push(`${r.confidence === 'EXACT' ? ' ' : '!'} ${r.qname}  ${r.path}:${r.start_line}-${r.end_line}`);
    if (external.length) {
      lines.push('  external:');
      for (const r of external) lines.push(`    ${r.package}${r.symbol ? '.' + r.symbol : ''} (${r.ecosystem})`);
    }
  } else {
    return errorResult(`Unknown direction '${direction}'. Use callers, callees, importers, impact, path, or explore.`);
  }

  const fitted = fitToBudget(lines, budgetOf(args));
  ledger.record('graph', fitted.tokens, 0);
  let text = fitted.lines.join('\n');
  if (fitted.dropped) text += `\n... ${fitted.dropped} more (raise budget)`;
  return textResult(text + staleness(store));
}

async function toolSimilar(store, config, args) {
  if (!config.embeddings?.enabled) {
    return errorResult(
      'Semantic search is not configured. Enable embeddings in .cgraph/config.json, ' +
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
  return `\n\n(index last updated ${Math.round(ageMin)} min ago — run \`cgraph update\` to refresh)`;
}

function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

