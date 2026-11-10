/**
 * `find`, as an agent uses it.
 *
 * The point of the tool is that an agent can get to the right lines without
 * already knowing what they are called and without reading its way there. So
 * these tests ask the three kinds of question an agent actually has — "it is
 * named roughly this", "it does this", "this exact text is somewhere" — and
 * check two things about each answer: the right symbol is at the top, and the
 * answer is not padded with lines that cost tokens and say nothing.
 *
 * Before this suite existed the search was tested only on name lookups, and
 * that is why a descriptive query putting the right function outside the top
 * five four times out of five went unnoticed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildFixture } from './fixture.js';
import { Store } from '../src/core/store.js';
import { Indexer } from '../src/core/indexer.js';
import { search, renderHits, displayName, location } from '../src/core/search.js';
import { find } from '../src/core/find.js';
import { textSearch } from '../src/core/textsearch.js';
import { findSymbol } from '../src/core/retrieve.js';
import { searchTerms, stem } from '../src/core/identifiers.js';
import { estimate } from '../src/core/tokens.js';

const require = createRequire(import.meta.url);
const skip = (() => {
  try { require.resolve('tree-sitter-wasms/package.json'); return false; }
  catch { return true; }
})();
const opts = { skip };

const REPO = {
  'package.json': '{"name":"demo"}',
  'src/net/client.js': [
    "import { backoffDelay } from './backoff.js';",
    '',
    '/** Sends a chunk to the storage service. */',
    'export async function sendChunk(chunk, attempt) {',
    '  try {',
    '    return await transport.put(chunk);',
    '  } catch (err) {',
    "    if (attempt > MAX_ATTEMPTS) throw new Error('upload gave up: connection refused');",
    '    await sleep(backoffDelay(attempt));',
    '    return sendChunk(chunk, attempt + 1);',
    '  }',
    '}',
    '',
    'export class Client {',
    '  /** Opens the socket. */',
    '  connect(host) {',
    "    this.socket = openSocket(host, { keepAlive: true, timeout: 30 });",
    '    return this.socket;',
    '  }',
    '',
    '  close() { this.socket.destroy(); }',
    '}',
    '',
    "const BANNER = 'Connection Refused by peer';",
    '',
  ].join('\n'),
  'src/net/backoff.js': [
    '/** Exponential delay before the next attempt, with jitter. */',
    'export function backoffDelay(attempt) {',
    '  return Math.min(30000, 2 ** attempt * 100) + Math.random() * 50;',
    '}',
    '',
  ].join('\n'),
  'src/ui/upload.js': [
    '/** Renders the upload button. */',
    'export function uploadButton(label) {',
    '  return `<button>${label}</button>`;',
    '}',
    '',
    'export function uploadProgress(done, total) {',
    '  return Math.round((done / total) * 100);',
    '}',
    '',
  ].join('\n'),
  'src/ui/retry.js': [
    'export function retryBanner() {',
    "  return 'Something went wrong';",
    '}',
    '',
  ].join('\n'),
  // A language with a grammar but no extraction queries: no symbols at all,
  // which is exactly where a symbol search has nothing to offer.
  'native/io.c': 'int flush_all(void) {\n  /* connection refused is handled upstream */\n  return 0;\n}\n',
};

const names = (hits) => hits.map((h) => h.node.name);

/**
 * Function bodies live only in the FTS5 index. Node builds without FTS5 (22.x,
 * among others) still search names, signatures and docs — covered below and in
 * search.test.js — but have nowhere to keep body words, so the tests that are
 * about bodies say so and step aside rather than fail.
 */
const NO_BODIES = 'this Node build has no FTS5; function bodies are not searchable';

// ---------------------------------------------------------------------------
// output: cheap, and enough to act on
// ---------------------------------------------------------------------------

test('a hit is one location, a line range, and a name — the path appears once', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const lines = renderHits(search(fx.store, 'backoffDelay'));
    assert.equal(lines[0], 'src/net/backoff.js:2-4  function backoffDelay');
    assert.equal(lines[1], '    function backoffDelay(attempt)');

    // The qualified name is `src/net/backoff.js::backoffDelay`. Printed beside
    // its own location that put the path on every line twice, and was most of
    // what a search cost.
    assert.equal(lines[0].split('src/net/backoff.js').length - 1, 1);

    // The range is the reason the agent does not have to read the file: these
    // are the exact lines of the definition.
    const hit = search(fx.store, 'backoffDelay')[0].node;
    assert.equal(location(hit), 'src/net/backoff.js:2-4');
    assert.equal(displayName(hit), 'backoffDelay');
  } finally { fx.cleanup(); }
});

test('members keep their container, which is how they are asked for again', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const hit = search(fx.store, 'connect').find((h) => h.node.kind === 'method');
    assert.equal(displayName(hit.node), 'Client#connect');

    // What search prints must be accepted back, or the agent has a name it
    // cannot use: `map symbol=Client#connect`.
    const [node] = findSymbol(fx.store, 'Client#connect');
    assert.equal(node.name, 'connect');
    assert.equal(search(fx.store, 'Client#connect')[0].node.id, node.id, 'a qualified query finds exactly that member');
  } finally { fx.cleanup(); }
});

test('an exact name returns that symbol, not a page of things that resemble it', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const hits = search(fx.store, 'backoffDelay');
    assert.deepEqual(names(hits), ['backoffDelay']);

    // It used to return up to twenty lines for a question with one answer.
    // What was left out is counted, never dropped in silence.
    const text = renderHits(hits).join('\n');
    assert.ok(estimate(text) < 60, `one exact hit cost ${estimate(text)} tokens`);
    if (hits.weaker) assert.match(text, /\+\d+ weaker match/);
  } finally { fx.cleanup(); }
});

test('an explicit limit is honoured in full, weak matches included', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const trimmed = search(fx.store, 'upload');
    const all = search(fx.store, 'upload', { limit: 50 });
    assert.equal(trimmed.weaker, all.length - trimmed.length, 'the default says exactly how many it held back');
    assert.equal(all.weaker, 0, 'and an explicit limit holds nothing back');
    assert.deepEqual(names(all).slice(0, trimmed.length), names(trimmed), 'same order, just more of it');
    // With bodies indexed there is something weak to hold back: `sendChunk`
    // mentions "upload" only inside an error message.
    if (fx.store.hasFts5) assert.ok(all.length > trimmed.length, 'asking for more returns more');
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------
// finding code without knowing its name
// ---------------------------------------------------------------------------

test('a description finds the function it describes', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    // None of these words is in the name `backoffDelay`... except one, and
    // `uploadButton` has none of them. The doc comment carries the match.
    assert.equal(search(fx.store, 'exponential delay with jitter')[0].node.name, 'backoffDelay');
    assert.equal(search(fx.store, 'renders the button')[0].node.name, 'uploadButton');
  } finally { fx.cleanup(); }
});

test('what a function does is searchable: the words inside its body', opts, async (t) => {
  const fx = await buildFixture(REPO);
  try {
    if (!fx.store.hasFts5) return t.skip(NO_BODIES);
    // `sendChunk` is not called retry, upload or anything else in this query.
    // It is the function that does it: its body is where `transport`, the
    // attempt limit and the backoff call are.
    assert.equal(search(fx.store, 'transport put attempts backoff')[0].node.name, 'sendChunk');

    // An identifier that is used but defined nowhere in the index. The only
    // useful answer is where it is used.
    const users = search(fx.store, 'MAX_ATTEMPTS');
    assert.equal(users[0].node.name, 'sendChunk');
    assert.ok(users[0].why.includes('uses'));
  } finally { fx.cleanup(); }
});

test('matching the whole question beats matching one word of it well', opts, async (t) => {
  const fx = await buildFixture(REPO);
  try {
    if (!fx.store.hasFts5) return t.skip(NO_BODIES);
    // `retryBanner` and `uploadButton` each have one query word in their
    // *name*, the strongest place a word can match. Neither is about retrying
    // an upload. Scoring strategies independently and summing, as search used
    // to, ranked them first; coverage of the query is what puts `sendChunk`
    // — which matches both words, only in weaker places — above them.
    const hits = search(fx.store, 'upload attempt connection refused', { limit: 10 });
    assert.equal(hits[0].node.name, 'sendChunk');
  } finally { fx.cleanup(); }
});

test('word forms match: "sending chunks" finds sendChunk', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    assert.equal(stem('sending'), 'send');
    assert.equal(stem('chunks'), 'chunk');
    assert.equal(stem('bus'), 'bus', 'never stems below four characters');
    assert.equal(search(fx.store, 'sending chunks')[0].node.name, 'sendChunk');
  } finally { fx.cleanup(); }
});

test('filler words in a question do not dilute it', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    assert.equal(search(fx.store, 'where is the socket opened')[0].node.name, 'connect');
  } finally { fx.cleanup(); }
});

test('keys of an object literal inside a function do not crowd out real symbols', opts, async (t) => {
  const fx = await buildFixture(REPO);
  try {
    if (!fx.store.hasFts5) return t.skip(NO_BODIES);
    // `{ keepAlive: true, timeout: 30 }` is indexed as two fields. For the
    // query "timeout" they are a match on the whole name — but they are an
    // argument, not a thing anyone searches for.
    const hits = search(fx.store, 'socket timeout', { limit: 10 });
    assert.equal(hits[0].node.name, 'connect');
  } finally { fx.cleanup(); }
});

test('a misspelt name still finds the symbol', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    assert.equal(search(fx.store, 'bakoffDelay')[0].node.name, 'backoffDelay');
  } finally { fx.cleanup(); }
});

test('body words are split like names and capped', () => {
  const terms = searchTerms('const x = retryWithBackoff(MAX_ATTEMPTS); // Retry later').split(' ');
  for (const w of ['retrywithbackoff', 'retry', 'with', 'backoff', 'max_attempts', 'max', 'attempts', 'later']) {
    assert.ok(terms.includes(w), `missing '${w}' in ${terms.join(' ')}`);
  }
  assert.equal(new Set(terms).size, terms.length, 'each word once');

  const many = Array.from({ length: 2000 }, (_, i) => `ident${i}`).join(' ');
  assert.ok(searchTerms(many).split(' ').length <= 256, 'one huge function cannot swamp the index');
  assert.equal(searchTerms(''), '');
});

// ---------------------------------------------------------------------------
// literal text
// ---------------------------------------------------------------------------

test('quoted text is searched literally and reported under the symbol it is in', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const config = { root: fx.root };
    const answer = await find(fx.store, config, { query: '"connection refused"' });
    assert.equal(answer.mode, 'text');
    const text = answer.lines.join('\n');

    // The thing grep cannot say: which function the line belongs to, and
    // where that function starts and ends.
    assert.match(text, /src\/net\/client\.js\n {2}in function sendChunk \(4-12\)\n\s+8 {2}if \(attempt > MAX_ATTEMPTS\)/);

    // All-lowercase is case-insensitive: the capitalised constant matches too.
    assert.match(text, /in const BANNER \(24\)\n\s+24 {2}const BANNER = 'Connection Refused by peer';/);

    // And it reaches files the symbol index has nothing for.
    assert.match(text, /native\/io\.c\n\s+2 {2}\/\* connection refused is handled upstream \*\//);
    assert.match(answer.lines[0], /3 lines in 2 files/);
  } finally { fx.cleanup(); }
});

test('a capital letter makes the text search case-sensitive', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const result = await textSearch(fx.store, fx.root, 'Connection Refused');
    assert.equal(result.total, 1);
    assert.equal(result.matches[0].line, 24);
    assert.equal(result.matches[0].symbol.name, 'BANNER');

    // A line outside every definition has no enclosing symbol, and says so by
    // omission rather than by naming the nearest one.
    const top = await textSearch(fx.store, fx.root, "from './backoff.js'");
    assert.equal(top.matches[0].line, 1);
    assert.equal(top.matches[0].symbol, null);
  } finally { fx.cleanup(); }
});

test('a query that names no symbol is tried as text before giving up', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const config = { root: fx.root };

    // `keepAlive` is an inline option key; ask for something that is in no
    // name, doc or body word the index would return: a fragment of a string.
    const answer = await find(fx.store, config, { query: 'handled upstream' });
    assert.equal(answer.mode, 'text', 'the agent is not sent off to grep');
    assert.match(answer.lines[0], /No symbol named 'handled upstream'; found as text/);
    assert.match(answer.lines.join('\n'), /native\/io\.c/);

    // Truly absent: say so, once, with the closest real names if there are any.
    const none = await find(fx.store, config, { query: 'zzqqxxnothere' });
    assert.equal(none.mode, 'none');
    assert.match(none.lines[0], /No symbols matching 'zzqqxxnothere'/);

    // A kind filter asks for a symbol specifically; text is not an answer.
    const filtered = await find(fx.store, config, { query: 'handled upstream', kind: 'function' });
    assert.equal(filtered.mode, 'none');
  } finally { fx.cleanup(); }
});

test('a text search that hits too many lines says how many it left out', opts, async () => {
  const files = { 'package.json': '{"name":"demo"}' };
  for (let i = 0; i < 6; i++) {
    files[`src/f${i}.js`] = Array.from({ length: 10 }, (_, j) => `export const v${i}_${j} = 'needle-token';`).join('\n') + '\n';
  }
  const fx = await buildFixture(files);
  try {
    const answer = await find(fx.store, { root: fx.root }, { query: '"needle-token"', limit: 5 });
    const text = answer.lines.join('\n');
    assert.match(answer.lines[0], /60 lines in 6 files/, 'the header counts everything');
    assert.match(text, /\(\+55 more lines not shown/, 'and the cut is announced');

    const scoped = await find(fx.store, { root: fx.root }, { query: '"needle-token"', path: 'src/f3.js' });
    assert.match(scoped.lines[0], /10 lines in 1 file/, 'path narrows a text search too');
  } finally { fx.cleanup(); }
});

test('a text search stops at its time budget and says how far it got', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    // A budget of -1 has already expired at the first check.
    const result = await textSearch(fx.store, fx.root, 'connection', { timeBudgetMs: -1 });
    assert.equal(result.timedOut, true);
    assert.equal(result.scanned, 0);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------------------
// index upgrades
// ---------------------------------------------------------------------------

test('an index built before bodies were searchable is rebuilt, whoever opens it first', opts, async (t) => {
  const fx = await buildFixture(REPO);
  if (!fx.store.hasFts5) { fx.cleanup(); return t.skip(NO_BODIES); }
  const dbFile = path.join(fx.root, '.cgraph', 'index.db');
  const config = { root: fx.root, db: dbFile };
  try {
    // Put the full-text table back the way the previous release created it.
    fx.store.exec(`
      DROP TABLE symbols_vocab; DROP TABLE symbols_fts; DELETE FROM fts_map;
      CREATE VIRTUAL TABLE symbols_fts USING fts5(name, parts, qname, signature, doc,
        content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
    `);
    fx.store.clearFullReindex();
    fx.store.close();

    // First opened by a reader — `cgraph find`, or the MCP server. It can
    // search names and docs straight away (they are backfilled)...
    const reader = await Store.open(dbFile, { create: false });
    assert.equal(search(reader, 'backoffDelay')[0].node.name, 'backoffDelay');
    assert.equal(reader.needsFullReindex, true);
    reader.close();

    // ...and the need for a rebuild is still there for the next process. When
    // it was only a field on the reader's Store object, it died with it, and
    // bodies stayed unsearchable for every file that never changed again.
    const store = await Store.open(dbFile);
    assert.equal(store.needsFullReindex, true, 'the request survived the reader exiting');
    const stats = await new Indexer({ store, config: { ...fx.registry.config, ...config }, registry: fx.registry }).run({});
    assert.ok(stats.parsed >= 4, 'every file was re-read without --force');
    assert.equal(search(store, 'transport put attempts backoff')[0].node.name, 'sendChunk');
    assert.equal(store.needsFullReindex, false);
    store.close();

    const later = await Store.open(dbFile);
    assert.equal(later.needsFullReindex, false, 'and it is not asked for twice');
    later.close();
  } finally {
    try { fs.rmSync(fx.root, { recursive: true, force: true }); } catch { /* AV may hold the WAL */ }
    fx.registry.dispose();
  }
});
