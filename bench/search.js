#!/usr/bin/env node
/**
 * Search benchmark: what an answer costs, and whether the answer is in it.
 *
 * `bench/run.js` measures response sizes and nothing else. That guards against
 * output getting chattier, but it cannot see the failure that costs an agent
 * the most: a small, cheap response that does not contain the symbol it was
 * looking for. So this measures both, on questions with a known right answer.
 *
 * Every question is built from the repository itself. A function is picked,
 * a query is derived from it in a way that does not hand over its name where
 * the point is to do without it, and the search is asked. The function is the
 * answer key.
 *
 *   by name          its exact name
 *   by description   four words from its doc comment
 *   by behaviour     three identifiers used in its body, none of them in its
 *                    name or signature — "the one that calls these"
 *   by partial name  one word of a compound name
 *
 * For each: how often the function is the first hit, in the first five, and
 * how many tokens the response cost.
 *
 * It also prints a comparison with grep. That needs an assumption, so here it
 * is, in full: grep means `grep -n -w <name>` over the same files, capped at
 * 250 output lines, counted as path:line:text. Nothing is assumed about what
 * an agent does next. It is the size of two answers to the same question, not
 * a claim about a whole workflow — for that, measure your own.
 *
 *   node bench/search.js                 # this repo
 *   node bench/search.js <path>...       # other repos
 *   node bench/search.js --json
 *
 * The index is built in a temporary directory; the target repo is not touched.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/core/config.js';
import { Store } from '../src/core/store.js';
import { Indexer } from '../src/core/indexer.js';
import { PackRegistry } from '../src/packs/registry.js';
import { estimate } from '../src/core/tokens.js';
import { search, renderHits, displayName } from '../src/core/search.js';
import { callers } from '../src/core/graph.js';

const SELF = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SAMPLE = 150;

const tokensOf = (lines) => lines.reduce((sum, l) => sum + estimate(l) + 1, 0);

const FILLER = new Set(
  'the a an of to in for and or is are be this that with from by on at as it its if not no can will into returns return get set'.split(' ')
);
const contentWords = (s) => (s.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !FILLER.has(w));

/** Every `step`-th element, so a sample spans the repo instead of its first directory. */
function spread(list, n) {
  const step = Math.max(1, Math.floor(list.length / n));
  return list.filter((_, i) => i % step === 0).slice(0, n);
}

async function benchmarkRepo(root) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-bench-'));
  const config = { ...loadConfig(root, { root }), db: path.join(tmp, 'index.db') };
  const store = await Store.open(config.db);
  const registry = await PackRegistry.load(config);

  try {
    const started = Date.now();
    const stats = await new Indexer({ store, config, registry }).run({});
    const indexMs = Date.now() - started;

    const pool = store.all(
      `SELECT n.id, n.name, n.doc, n.start_byte, n.end_byte, f.path, f.tok AS file_tok
         FROM nodes n JOIN files f ON f.id = n.file_id
        WHERE n.kind IN ('function', 'method') AND LENGTH(n.name) > 4
        ORDER BY n.id`
    );

    const sources = new Map();
    const read = (rel) => {
      if (!sources.has(rel)) {
        try { sources.set(rel, fs.readFileSync(path.join(root, rel), 'utf8')); }
        catch { sources.set(rel, ''); }
      }
      return sources.get(rel);
    };

    const ask = (label, candidates, makeQuery) => {
      let first = 0, five = 0, asked = 0, tokens = 0, ms = 0;
      for (const fn of candidates) {
        const query = makeQuery(fn);
        if (!query) continue;
        asked++;
        const t = performance.now();
        const hits = search(store, query);
        ms += performance.now() - t;
        tokens += tokensOf(renderHits(hits));
        const at = hits.findIndex((h) => h.node.id === fn.id);
        if (at === 0) first++;
        if (at >= 0 && at < 5) five++;
      }
      return asked
        ? { label, asked, top1: first / asked, top5: five / asked, tokens: Math.round(tokens / asked), ms: ms / asked }
        : { label, asked: 0 };
    };

    const sample = spread(pool, SAMPLE);
    const results = [
      ask('by name', sample, (fn) => fn.name),
      ask('by description', spread(pool.filter((fn) => fn.doc && contentWords(fn.doc).length >= 4), SAMPLE),
        (fn) => contentWords(fn.doc).slice(0, 4).join(' ')),
      ask('by behaviour', sample, (fn) => {
        const body = read(fn.path).slice(fn.start_byte, fn.end_byte);
        if (body.length < 200) return null;
        const head = body.slice(0, body.indexOf('\n') + 1 || 80).toLowerCase();
        const used = [...new Set(body.match(/[A-Za-z_][A-Za-z0-9_]{5,}/g) ?? [])]
          .filter((w) => w !== fn.name && !head.includes(w.toLowerCase()));
        if (used.length < 3) return null;
        // The three longest: specific, and the same three on every run.
        return used.sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).slice(0, 3).join(' ');
      }),
      ask('by partial name', sample, (fn) => {
        const parts = fn.name.split(/_|(?<=[a-z0-9])(?=[A-Z])/).filter((p) => p.length >= 4);
        return parts.length >= 2 ? parts[parts.length - 1].toLowerCase() : null;
      }),
    ];

    // The same question, answered by grep and by cgraph.
    const textFiles = store.all(
      `SELECT path FROM files WHERE skip_reason IS NULL OR skip_reason IN ('no-queries', 'no-language')`
    );
    const grepTokens = (word) => {
      const re = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      let tokens = 0, lines = 0;
      for (const f of textFiles) {
        const text = read(f.path);
        if (!text.includes(word)) continue;
        const rows = text.split('\n');
        for (let i = 0; i < rows.length; i++) {
          if (!re.test(rows[i])) continue;
          tokens += estimate(`${f.path}:${i + 1}:${rows[i].slice(0, 300)}`) + 1;
          if (++lines >= 250) return tokens;
        }
      }
      return tokens;
    };

    const compared = spread(pool, 60);
    let grep = 0, find = 0, who = 0, wholeFile = 0, symbol = 0;
    for (const fn of compared) {
      grep += grepTokens(fn.name);
      find += tokensOf(renderHits(search(store, fn.name)));
      who += tokensOf(callers(store, fn.id, { limit: 60 }).map((r) => `  ${displayName(r)}  ${r.path}:${r.line}`)) + 20;
      wholeFile += fn.file_tok;
      symbol += estimate(read(fn.path).slice(fn.start_byte, fn.end_byte));
    }
    const n = compared.length || 1;

    return {
      repo: path.basename(root),
      files: stats.seen,
      symbols: store.stats().nodes,
      indexMs,
      results,
      comparison: {
        sampled: compared.length,
        grep: Math.round(grep / n),
        find: Math.round(find / n),
        callers: Math.round(who / n),
        wholeFile: Math.round(wholeFile / n),
        symbol: Math.round(symbol / n),
      },
    };
  } finally {
    registry.dispose();
    store.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* AV may hold the WAL */ }
  }
}

function report(summaries) {
  const pct = (x) => `${Math.round(x * 100)}%`.padStart(5);
  for (const s of summaries) {
    console.log('');
    console.log(`${s.repo}  ${s.files} files, ${s.symbols} symbols  ·  indexed in ${(s.indexMs / 1000).toFixed(1)}s`);
    console.log('');
    console.log(`  ${'question'.padEnd(18)} ${'asked'.padStart(5)}  ${'first'.padStart(5)}  ${'top 5'.padStart(5)}  ${'tokens'.padStart(6)}  ${'ms'.padStart(5)}`);
    for (const r of s.results) {
      if (!r.asked) { console.log(`  ${r.label.padEnd(18)} ${'—'.padStart(5)}  (no suitable functions)`); continue; }
      console.log(`  ${r.label.padEnd(18)} ${String(r.asked).padStart(5)}  ${pct(r.top1)}  ${pct(r.top5)}  ${String(r.tokens).padStart(6)}  ${r.ms.toFixed(1).padStart(5)}`);
    }

    const c = s.comparison;
    const less = (a, b) => (b ? `${Math.round((1 - a / b) * 100)}% smaller` : '');
    console.log('');
    console.log(`  the same question two ways (mean over ${c.sampled} functions, tokens)`);
    console.log(`    where is <name>      grep -nw ${String(c.grep).padStart(6)}   find         ${String(c.find).padStart(6)}   ${less(c.find, c.grep)}`);
    console.log(`    who calls <name>     grep -nw ${String(c.grep).padStart(6)}   map callers  ${String(c.callers).padStart(6)}   ${less(c.callers, c.grep)}`);
    console.log(`    read its definition  file     ${String(c.wholeFile).padStart(6)}   start-end    ${String(c.symbol).padStart(6)}   ${less(c.symbol, c.wholeFile)}`);
  }
  console.log('');
  console.log('  "first" and "top 5" are how often the function the question was built');
  console.log('  from came back in that position. A name shared by several functions');
  console.log('  cannot be first for all of them, so "by name" tops out below 100%.');
  console.log('  The grep column is the output of one grep, capped at 250 lines — two');
  console.log('  answers to one question, not a model of what an agent does next.');
  console.log('');
}

const args = process.argv.slice(2);
const roots = args.filter((a) => !a.startsWith('--'));
const targets = roots.length ? roots.map((r) => path.resolve(r)) : [SELF];

const summaries = [];
for (const root of targets) {
  if (!fs.existsSync(root)) { console.error(`skipping missing path: ${root}`); continue; }
  summaries.push(await benchmarkRepo(root));
}

if (args.includes('--json')) console.log(JSON.stringify(summaries, null, 2));
else report(summaries);
