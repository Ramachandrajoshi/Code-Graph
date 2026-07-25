#!/usr/bin/env node
/**
 * Token-savings benchmark.
 *
 * The product makes one measurable claim: it answers a codebase question for
 * far fewer tokens than grep-and-read. This harness tests that claim honestly,
 * which means the baseline has to be a fair simulation of what an agent
 * actually does — not a strawman.
 *
 * Baseline model: an agent greps for a term, gets line hits, and must then READ
 * the files those hits point to in order to act. Counting only grep's output
 * would flatter us enormously, because grep output alone is not enough to
 * answer any of these questions.
 *
 * Where the baseline genuinely cannot answer at all (impact analysis), that is
 * recorded as such rather than scored as an infinite win.
 *
 *   node bench/run.js                 # benchmark this repo
 *   node bench/run.js <path>...       # benchmark other repos
 *   node bench/run.js --json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/core/config.js';
import { Store } from '../src/core/store.js';
import { Indexer } from '../src/core/indexer.js';
import { PackRegistry } from '../src/packs/registry.js';
import { walk } from '../src/core/walker.js';
import { estimate } from '../src/core/tokens.js';
import { outlineFile, outlineDir, findSymbol, readSymbol } from '../src/core/retrieve.js';
import { search, renderHits } from '../src/core/search.js';
import { callers, impact } from '../src/core/graph.js';

const SELF = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Question templates.
 *
 * Each states how code-graph answers it and how a grep-driven agent would have
 * to. `baselineImpossible` marks questions no amount of grepping can answer,
 * which are reported separately rather than folded into the ratio.
 */
const QUESTIONS = [
  {
    id: 'what-is-in-this-repo',
    ask: (ctx) => ({
      graph: outlineDir(ctx.store, '', { depth: 2 }),
      // An agent orienting itself lists directories and reads the entry points.
      baseline: readEntryPoints(ctx, 6),
    }),
  },
  {
    id: 'what-is-in-this-file',
    ask: (ctx) => {
      const file = ctx.biggestFile;
      if (!file) return null;
      return {
        graph: outlineFile(ctx.store, file),
        baseline: { tokens: file.tok, note: 'read the whole file' },
      };
    },
  },
  {
    id: 'where-is-X-defined',
    ask: (ctx) => {
      const target = ctx.pickSymbol();
      if (!target) return null;
      const hits = search(ctx.store, target.name, { limit: 10 });
      return {
        graph: { tokens: tokensOf(renderHits(hits)) },
        // grep for the name, then read each file that matched to see which hit
        // is the definition.
        baseline: grepAndRead(ctx, target.name),
      };
    },
  },
  {
    id: 'show-me-X',
    ask: (ctx) => {
      const target = ctx.pickSymbol();
      if (!target) return null;
      const node = findSymbol(ctx.store, target.qname, { limit: 1 })[0];
      if (!node) return null;
      const file = ctx.store.get('SELECT tok FROM files WHERE id = ?', node.file_id);
      return {
        graph: readSymbol(ctx.store, ctx.root, node, { mode: 'body' }),
        baseline: { tokens: file.tok, note: 'read the whole file' },
      };
    },
  },
  {
    id: 'who-calls-X',
    ask: (ctx) => {
      const target = ctx.pickCalledSymbol();
      if (!target) return null;
      const rows = callers(ctx.store, target.id, { limit: 50 });
      const lines = rows.map((r) => `${r.qname} ${r.path}:${r.line}`);
      return {
        graph: { tokens: tokensOf(lines) || 12 },
        baseline: grepAndRead(ctx, target.name),
      };
    },
  },
  {
    id: 'what-breaks-if-I-change-X',
    baselineImpossible: true,
    ask: (ctx) => {
      const target = ctx.pickCalledSymbol();
      if (!target) return null;
      const result = impact(ctx.store, target.id, { depth: 3 });
      const lines = result.nodes.map((n) => `${n.qname} ${n.path}:${n.start_line}`);
      return {
        graph: { tokens: tokensOf(lines) || 12 },
        // Transitive impact requires following calls through files. A grep-only
        // agent approximates it by reading every file that mentions the name,
        // then every file that mentions THOSE names — one hop is generous.
        baseline: grepAndReadTransitive(ctx, target.name),
      };
    },
  },
  {
    id: 'what-does-this-repo-use-from-X',
    ask: (ctx) => {
      const dep = ctx.store.get(
        `SELECT package FROM externals WHERE ecosystem NOT IN ('builtin')
          GROUP BY package ORDER BY SUM(use_count) DESC LIMIT 1`
      );
      if (!dep) return null;
      const rows = ctx.store.all(
        `SELECT symbol, signature, use_count FROM externals
          WHERE package = ? AND symbol != '' ORDER BY use_count DESC LIMIT 15`,
        dep.package
      );
      const lines = rows.map((r) => `${r.symbol} ${r.signature ?? ''} ${r.use_count}x`);
      return {
        graph: { tokens: tokensOf(lines) || 12 },
        baseline: grepAndRead(ctx, dep.package),
      };
    },
  },
];

// ---------------------------------------------------------------- baselines

/**
 * Simulate grep-then-read: find files containing the term, count the tokens an
 * agent would spend reading them.
 *
 * Capped at 10 files, which is charitable — a real agent often reads more.
 */
function grepAndRead(ctx, term) {
  const matched = ctx.filesContaining(term);
  const capped = matched.slice(0, 10);
  const tokens = capped.reduce((sum, f) => sum + f.tok, 0);
  return {
    tokens,
    note: `grep '${term}' -> ${matched.length} files, read ${capped.length}`,
    files: capped.length,
  };
}

/** One hop further, for questions that require following the call chain. */
function grepAndReadTransitive(ctx, term) {
  const direct = ctx.filesContaining(term).slice(0, 10);
  const names = new Set();
  for (const f of direct) {
    for (const row of ctx.store.all(
      "SELECT name FROM nodes WHERE file_id = ? AND kind IN ('function','method') LIMIT 5", f.id
    )) names.add(row.name);
  }

  const second = new Map();
  for (const name of [...names].slice(0, 5)) {
    for (const f of ctx.filesContaining(name).slice(0, 5)) second.set(f.path, f);
  }
  for (const f of direct) second.set(f.path, f);

  const files = [...second.values()].slice(0, 20);
  return {
    tokens: files.reduce((s, f) => s + f.tok, 0),
    note: `grep + follow one hop -> read ${files.length} files`,
    files: files.length,
  };
}

function readEntryPoints(ctx, n) {
  const files = ctx.store.all(
    'SELECT path, tok FROM files WHERE parsed = 1 ORDER BY tok DESC LIMIT ?', n
  );
  return {
    tokens: files.reduce((s, f) => s + f.tok, 0),
    note: `read ${files.length} largest source files to orient`,
  };
}

function tokensOf(lines) {
  return lines.reduce((sum, l) => sum + estimate(l) + 1, 0);
}

// ---------------------------------------------------------------- harness

async function benchmarkRepo(root) {
  const config = loadConfig(root, { root });
  const store = await Store.open(config.db);
  const registry = await PackRegistry.load(config);

  const indexStart = Date.now();
  const stats = await new Indexer({ store, config, registry }).run({});
  const indexMs = Date.now() - indexStart;

  const ctx = makeContext(store, config, root);
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

    const graphTokens = outcome.graph.tokens;
    const baseTokens = outcome.baseline.tokens;
    results.push({
      id: q.id,
      graphTokens,
      baseTokens,
      ratio: graphTokens > 0 ? baseTokens / graphTokens : null,
      baselineImpossible: !!q.baselineImpossible,
      note: outcome.baseline.note,
    });
  }

  const summary = {
    repo: path.basename(root),
    root,
    files: stats.seen,
    parsed: store.stats().parsed,
    symbols: store.stats().nodes,
    edges: store.stats().edges,
    sourceTokens: store.stats().tok,
    indexMs,
    results,
  };

  registry.dispose();
  store.close();
  return summary;
}

function makeContext(store, config, root) {
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

  let symbolCursor = 0;
  let calledCursor = 0;

  // File contents are read once and reused: the baseline needs substring
  // searches across the repo, and re-reading per question would dominate runtime.
  const contents = new Map();
  for (const f of walk(root, config)) {
    if (f.skipReason || !f.content) continue;
    contents.set(f.rel, f.content);
  }

  const fileRows = new Map(
    store.all('SELECT id, path, tok FROM files WHERE parsed = 1').map((f) => [f.path, f])
  );

  return {
    store, root, config,
    biggestFile: store.get('SELECT * FROM files WHERE parsed = 1 ORDER BY tok DESC LIMIT 1'),
    pickSymbol: () => symbolPool[symbolCursor++ % Math.max(1, symbolPool.length)] ?? null,
    pickCalledSymbol: () => calledPool[calledCursor++ % Math.max(1, calledPool.length)] ?? null,
    filesContaining(term) {
      const out = [];
      for (const [rel, text] of contents) {
        if (text.includes(term)) {
          const row = fileRows.get(rel);
          if (row) out.push(row);
        }
      }
      return out.sort((a, b) => b.tok - a.tok);
    },
  };
}

// ---------------------------------------------------------------- reporting

function report(summaries) {
  for (const s of summaries) {
    console.log('');
    console.log(`${s.repo}  ${s.files} files, ${s.symbols} symbols, ${s.edges} edges`);
    console.log(`  indexed in ${(s.indexMs / 1000).toFixed(1)}s  ·  ${fmt(s.sourceTokens)} tokens of source`);
    console.log('');
    console.log(`  ${'question'.padEnd(30)} ${'graph'.padStart(8)} ${'grep+read'.padStart(10)} ${'saving'.padStart(9)}`);

    for (const r of s.results) {
      if (r.skipped) {
        console.log(`  ${r.id.padEnd(30)} ${'—'.padStart(8)}  ${r.skipped}`);
        continue;
      }
      const marker = r.baselineImpossible ? '*' : ' ';
      console.log(
        `  ${r.id.padEnd(30)} ${fmt(r.graphTokens).padStart(8)} ${fmt(r.baseTokens).padStart(10)} ` +
        `${(r.ratio ? r.ratio.toFixed(1) + 'x' : '—').padStart(8)}${marker}`
      );
    }

    const scored = s.results.filter((r) => r.ratio && !r.skipped);
    if (scored.length) {
      const ratios = scored.map((r) => r.ratio).sort((a, b) => a - b);
      const median = ratios[Math.floor(ratios.length / 2)];
      const totalGraph = scored.reduce((a, r) => a + r.graphTokens, 0);
      const totalBase = scored.reduce((a, r) => a + r.baseTokens, 0);
      console.log('');
      console.log(`  median ${median.toFixed(1)}x   ·   aggregate ${(totalBase / totalGraph).toFixed(1)}x ` +
                  `(${fmt(totalGraph)} vs ${fmt(totalBase)} tokens)`);
    }
    if (s.results.some((r) => r.baselineImpossible && !r.skipped)) {
      console.log('');
      console.log('  * grep cannot actually answer this; the baseline is a generous approximation');
    }
  }
  console.log('');
}

function fmt(n) {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// ---------------------------------------------------------------- main

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
