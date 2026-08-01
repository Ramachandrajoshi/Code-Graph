#!/usr/bin/env node
/**
 * Response-size benchmark.
 *
 * Measures ONE thing: how many tokens cgraph returns for a set of typical
 * questions. It is a regression guard — if a change makes `map` or `graph`
 * chattier, the numbers here move and someone notices.
 *
 * It deliberately does NOT compute a savings multiplier against grep.
 *
 * An earlier version did, and the number was not trustworthy. Any such ratio
 * requires assuming what the alternative would have been: how many files an
 * agent would have opened, whether it read them whole or in windows, how many
 * probes it needed. That assumption does more work than the measurement, and
 * every plausible choice of assumption produces a wildly different — and
 * conveniently flattering — result. Publishing it would have been marketing
 * dressed as data.
 *
 * If you want to know what cgraph saves you, measure your own workflow on your
 * own repository. That number is real; this one is only comparable to itself.
 *
 *   node bench/run.js                 # this repo
 *   node bench/run.js <path>...       # other repos
 *   node bench/run.js --json          # for tracking across commits
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/core/config.js';
import { Store } from '../src/core/store.js';
import { Indexer } from '../src/core/indexer.js';
import { PackRegistry } from '../src/packs/registry.js';
import { estimate } from '../src/core/tokens.js';
import { outlineFile, outlineDir, findSymbol, readSymbol } from '../src/core/retrieve.js';
import { search, renderHits } from '../src/core/search.js';
import { callers, impact } from '../src/core/graph.js';

const SELF = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Questions an agent actually asks, and the response each produces.
 *
 * `context` records a comparable quantity where one genuinely exists — the size
 * of the file an outline describes, for instance. That is a fact about two
 * artifacts, not a claim about what you would otherwise have done.
 */
const QUESTIONS = [
  {
    id: 'repo-overview',
    ask: (ctx) => ({ result: outlineDir(ctx.store, '', { depth: 2 }) }),
  },
  {
    id: 'file-outline',
    ask: (ctx) => {
      if (!ctx.biggestFile) return null;
      return {
        result: outlineFile(ctx.store, ctx.biggestFile),
        context: `file is ${fmt(ctx.biggestFile.tok)} tokens`,
      };
    },
  },
  {
    id: 'locate-symbol',
    ask: (ctx) => {
      const target = ctx.pickSymbol();
      if (!target) return null;
      const hits = search(ctx.store, target.name, { limit: 10 });
      return { result: { tokens: tokensOf(renderHits(hits)) }, context: `${hits.length} hits` };
    },
  },
  {
    id: 'read-one-symbol',
    ask: (ctx) => {
      const target = ctx.pickSymbol();
      if (!target) return null;
      const node = findSymbol(ctx.store, target.qname, { limit: 1 })[0];
      if (!node) return null;
      const file = ctx.store.get('SELECT tok FROM files WHERE id = ?', node.file_id);
      return {
        result: readSymbol(ctx.store, ctx.root, node, { mode: 'body' }),
        context: `enclosing file is ${fmt(file.tok)} tokens`,
      };
    },
  },
  {
    id: 'who-calls',
    ask: (ctx) => {
      const target = ctx.pickCalledSymbol();
      if (!target) return null;
      const rows = callers(ctx.store, target.id, { limit: 50 });
      return {
        result: { tokens: tokensOf(rows.map((r) => `${r.qname} ${r.path}:${r.line}`)) || 12 },
        context: `${rows.length} callers`,
      };
    },
  },
  {
    id: 'impact-of-change',
    ask: (ctx) => {
      const target = ctx.pickCalledSymbol();
      if (!target) return null;
      const result = impact(ctx.store, target.id, { depth: 3 });
      return {
        result: { tokens: tokensOf(result.nodes.map((n) => `${n.qname} ${n.path}:${n.start_line}`)) || 12 },
        context: `${result.nodes.length} symbols affected`,
      };
    },
  },
];

function tokensOf(lines) {
  return lines.reduce((sum, l) => sum + estimate(l) + 1, 0);
}

async function benchmarkRepo(root) {
  const config = loadConfig(root, { root });
  const store = await Store.open(config.db);
  const registry = await PackRegistry.load(config);

  const started = Date.now();
  const stats = await new Indexer({ store, config, registry }).run({});
  const indexMs = Date.now() - started;

  const ctx = makeContext(store, root);
  const results = [];

  for (const q of QUESTIONS) {
    let outcome;
    try {
      outcome = q.ask(ctx);
    } catch (err) {
      results.push({ id: q.id, skipped: err.message });
      continue;
    }
    if (!outcome) {
      results.push({ id: q.id, skipped: 'no suitable symbol in this repo' });
      continue;
    }
    results.push({ id: q.id, tokens: outcome.result.tokens, context: outcome.context ?? '' });
  }

  const s = store.stats();
  const summary = {
    repo: path.basename(root),
    root,
    files: stats.seen,
    parsed: s.parsed,
    symbols: s.nodes,
    edges: s.edges,
    sourceTokens: s.tok,
    indexMs,
    results,
  };

  registry.dispose();
  store.close();
  return summary;
}

function makeContext(store, root) {
  const symbolPool = store.all(
    `SELECT n.id, n.name, n.qname, n.kind FROM nodes n
      WHERE n.kind IN ('function','method','class') AND LENGTH(n.name) > 3
      ORDER BY n.rank DESC LIMIT 40`
  );
  const calledPool = store.all(
    `SELECT n.id, n.name, n.qname, COUNT(e.id) AS uses
       FROM nodes n JOIN edges e ON e.dst_id = n.id
      WHERE n.kind IN ('function','method')
      GROUP BY n.id ORDER BY uses DESC LIMIT 20`
  );

  let i = 0, j = 0;
  return {
    store, root,
    biggestFile: store.get('SELECT * FROM files WHERE parsed = 1 ORDER BY tok DESC LIMIT 1'),
    pickSymbol: () => symbolPool[i++ % Math.max(1, symbolPool.length)] ?? null,
    pickCalledSymbol: () => calledPool[j++ % Math.max(1, calledPool.length)] ?? null,
  };
}

function report(summaries) {
  for (const s of summaries) {
    console.log('');
    console.log(`${s.repo}  ${s.files} files, ${s.symbols} symbols, ${s.edges} edges`);
    console.log(`  indexed in ${(s.indexMs / 1000).toFixed(1)}s  ·  ${fmt(s.sourceTokens)} tokens of source`);
    console.log('');
    console.log(`  ${'question'.padEnd(24)} ${'response'.padStart(9)}   context`);

    for (const r of s.results) {
      if (r.skipped) {
        console.log(`  ${r.id.padEnd(24)} ${'—'.padStart(9)}   ${r.skipped}`);
        continue;
      }
      console.log(`  ${r.id.padEnd(24)} ${(fmt(r.tokens) + ' tok').padStart(9)}   ${r.context}`);
    }

    const measured = s.results.filter((r) => !r.skipped);
    if (measured.length) {
      const total = measured.reduce((a, r) => a + r.tokens, 0);
      console.log('');
      console.log(`  ${measured.length} questions answered in ${fmt(total)} tokens total`);
    }
  }

  console.log('');
  console.log('  These are response sizes, not savings. Comparable across commits');
  console.log('  of cgraph; not comparable to any other tool or workflow.');
  console.log('');
}

function fmt(n) {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const roots = args.filter((a) => !a.startsWith('--'));
const targets = roots.length ? roots.map((r) => path.resolve(r)) : [SELF];

const summaries = [];
for (const root of targets) {
  if (!fs.existsSync(root)) {
    console.error(`skipping missing path: ${root}`);
    continue;
  }
  summaries.push(await benchmarkRepo(root));
}

if (asJson) console.log(JSON.stringify(summaries, null, 2));
else report(summaries);
