/**
 * `cgraph graph` — callers, callees, importers, impact, and paths.
 *
 * The command with no shell equivalent. Everything else in this tool makes
 * existing workflows cheaper; this one answers questions grep cannot answer at
 * all.
 */

import { loadConfig } from '../../core/config.js';
import { Store } from '../../core/store.js';
import { findSymbol } from '../../core/retrieve.js';
import { callers, callees, importers, impact, shortestPath, hydrate } from '../../core/graph.js';
import { degree } from '../../core/rank.js';
import { UsageLedger, fitToBudget } from '../../core/tokens.js';
import { out, json, color } from '../ui.js';

export async function run(args) {
  if (args.help) return help();

  const target = args._[0] ?? args.symbol;
  if (!target) throw new Error('graph: give a symbol name');

  const config = loadConfig(process.cwd(), args.root ? { root: args.root } : {});
  const store = await Store.open(config.db, { create: false });

  try {
    const dir = args.dir ?? 'callers';
    const node = resolveOne(store, target);

    // Optional precision pass: consult a language server to turn name-match
    // guesses into proven edges. Explicit because starting a language server is
    // slow, and the tree-sitter answer is usually good enough.
    if (args.upgrade) {
      const { upgradeFile } = await import('../../lsp/client.js');
      const { PackRegistry } = await import('../../packs/registry.js');
      const registry = await PackRegistry.load(config);
      const file = store.get('SELECT path FROM files WHERE id = ?', node.file_id);
      const result = await upgradeFile(store, config, registry, file.path);
      registry.dispose();

      if (result.error) out(color.yellow(`  lsp upgrade failed: ${result.error}`));
      else if (result.reason) out(color.dim(`  ${result.reason}`));
      else out(color.dim(`  upgraded ${result.upgraded}/${result.considered} inferred edges via language server`));
    }

    const lines = [];
    switch (dir) {
      case 'callers':   renderCallers(store, node, args, lines); break;
      case 'callees':   renderCallees(store, node, args, lines); break;
      case 'importers': renderImporters(store, node, lines); break;
      case 'impact':    renderImpact(store, node, args, lines); break;
      case 'path':      renderPath(store, node, args, lines); break;
      default:
        throw new Error(
          `unknown --dir '${dir}'. Use: callers, callees, importers, impact, path`
        );
    }

    if (args.json) return json({ symbol: node.qname, direction: dir, lines });

    const fitted = fitToBudget(lines, args.budget ?? config.defaultBudget);
    for (const line of fitted.lines) out(line);
    if (fitted.dropped) out(color.dim(`... ${fitted.dropped} more (raise --budget)`));

    new UsageLedger(store).record('graph', fitted.tokens, 0);
    if (!args.quiet) {
      out('');
      out(color.dim(`~${fitted.tokens} tokens`));
    }
  } finally {
    store.close();
  }
}

function resolveOne(store, target) {
  const matches = findSymbol(store, target, { limit: 5 });
  if (!matches.length) throw new Error(`No symbol named '${target}'. Try \`cgraph find ${target}\`.`);
  return matches[0];
}

/** `!` marks an inferred edge, so a reader never mistakes a guess for a fact. */
function confMark(confidence) {
  return confidence === 'EXACT' ? ' ' : '!';
}

function renderCallers(store, node, args, lines) {
  const rows = callers(store, node.id, {
    limit: args.limit ?? 50,
    minConfidence: args.exact ? 'EXACT' : null,
  });
  const d = degree(store, node.id);

  lines.push(`${node.qname}  ${node.path}:${node.start_line}`);
  lines.push(`callers: ${d.callers}   callees: ${d.callees}`);
  lines.push('');

  if (!rows.length) {
    lines.push('  (no callers found — an entry point, dead code, or called dynamically)');
    return;
  }
  for (const r of rows) {
    const times = r.sites > 1 ? ` (${r.sites}x)` : '';
    lines.push(`${confMark(r.confidence)} ${r.qname}  ${r.path}:${r.line}  ${r.edge_kind}${times}`);
  }
  if (rows.some((r) => r.confidence !== 'EXACT')) {
    lines.push('');
    lines.push(color.dim('! = inferred from a name match, not proven through an import'));
  }
}

function renderCallees(store, node, args, lines) {
  const { internal, external } = callees(store, node.id, { limit: args.limit ?? 50 });

  lines.push(`${node.qname} calls:`);
  lines.push('');
  for (const r of internal) {
    lines.push(`${confMark(r.confidence)} ${r.qname}  ${r.path}:${r.start_line}`);
  }
  if (external.length) {
    lines.push('');
    lines.push('external:');
    for (const r of external) {
      const sym = r.symbol ? `.${r.symbol}` : '';
      lines.push(`  ${r.package}${sym}  (${r.ecosystem})`);
    }
  }
  if (!internal.length && !external.length) lines.push('  (calls nothing this index knows about)');
}

function renderImporters(store, node, lines) {
  const file = store.get('SELECT * FROM files WHERE id = ?', node.file_id);
  const rows = importers(store, file.id);

  lines.push(`files importing ${file.path}:`);
  lines.push('');
  if (!rows.length) {
    lines.push('  (nothing imports this file)');
    return;
  }
  for (const r of rows) {
    lines.push(`  ${r.path}:${r.line}  ${r.symbol ?? r.spec}`);
  }
}

function renderImpact(store, node, args, lines) {
  const result = impact(store, node.id, {
    depth: args.depth ?? 3,
    limit: args.limit ?? 200,
    minConfidence: args.exact ? 'EXACT' : null,
  });

  lines.push(`impact of changing ${node.qname}:`);
  lines.push(`${result.nodes.length} symbols affected, depth ${args.depth ?? 3}`);
  lines.push('');

  if (!result.nodes.length) {
    lines.push('  (nothing depends on this)');
    return;
  }

  let currentDepth = 0;
  for (const r of result.nodes) {
    if (r.distance !== currentDepth) {
      currentDepth = r.distance;
      lines.push(`  ${currentDepth === 1 ? 'direct' : `${currentDepth} hops`}:`);
    }
    lines.push(`  ${confMark(r.confidence)} ${r.qname}  ${r.path}:${r.start_line}`);
  }

  if (result.truncated) {
    lines.push('');
    lines.push(color.dim('truncated: this symbol is central enough that the full set is large'));
  }
}

function renderPath(store, node, args, lines) {
  const toName = args._[1] ?? args.to;
  if (!toName) throw new Error('graph --dir path: give a destination symbol as the second argument');

  const dest = resolveOne(store, toName);
  const ids = shortestPath(store, node.id, dest.id, { maxDepth: args.depth ?? 8 });

  if (!ids) {
    lines.push(`no call path from ${node.qname} to ${dest.qname}`);
    return;
  }

  const rows = hydrate(store, ids);
  lines.push(`${rows.length - 1} hops from ${node.qname} to ${dest.qname}:`);
  lines.push('');
  rows.forEach((r, i) => {
    lines.push(`  ${i === 0 ? ' ' : '↓'} ${r.qname}  ${r.path}:${r.start_line}`);
  });
}

function help() {
  out(`
${color.bold('cgraph graph')} — traverse relationships between symbols

  cgraph graph login                       Who calls login
  cgraph graph login --dir callees         What login calls
  cgraph graph login --dir impact          What breaks if login changes
  cgraph graph login --dir importers       Which files import login's file
  cgraph graph handler --dir path saveUser How handler reaches saveUser

${color.bold('OPTIONS')}
  --dir <d>     callers | callees | importers | impact | path
  --depth <n>   Traversal depth (impact default 3, path default 8)
  --limit <n>   Maximum results
  --exact       Only proven edges; hide name-match guesses
  --upgrade     Consult a language server first to prove inferred edges (slow)
  --budget <n>  Cap the response in tokens
  --json        Machine-readable output
`);
}
