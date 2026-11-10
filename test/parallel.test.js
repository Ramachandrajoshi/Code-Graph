/**
 * Index speed: the pieces that make a large first index fast, and the
 * guarantees that keep them from changing what gets indexed.
 *
 * Three things are covered, each of which regressed silently before:
 *
 *   - Doc-comment lookup. Hooks used to slice and regex the whole file prefix
 *     once per definition, which is quadratic in file size and was 40% of
 *     index time on a large repo. The replacement must return exactly what the
 *     slow version did.
 *   - Parser threads. A pooled run must produce the same rows, with the same
 *     ids, as a single-threaded one — otherwise resolution tie-breaks, and so
 *     the graph itself, would depend on how many cores the machine has.
 *   - Progress. Phases with a known size draw a bar; nothing is written when
 *     output is piped.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { Store } from '../src/core/store.js';
import { Indexer } from '../src/core/indexer.js';
import { PackRegistry } from '../src/packs/registry.js';
import { DEFAULTS } from '../src/core/config.js';
import { linesAbove, trimEndIndex } from '../src/core/text.js';
import { Progress, phaseSummary, count } from '../src/cli/ui.js';

const require = createRequire(import.meta.url);
const skip = (() => {
  try { require.resolve('tree-sitter-wasms/package.json'); return false; }
  catch { return true; }
})();
const opts = { skip };

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

const SAMPLES = [
  '',
  '\n',
  '\n\n',
  'one line, no newline',
  'a\nb\nc',
  'a\nb\nc\n',
  '\nleading newline\nthen text',
  '/** doc */\nexport function f() {}\n',
  'x\r\ny\r\n  z',
  '\n\n\n   \n\t\nend',
];

test('linesAbove yields exactly the lines a full split would, nearest first', () => {
  // The contract every docComment hook now relies on. If this drifts from the
  // split-based original by even one empty line, doc comments attach to the
  // wrong definition or vanish — and nothing else would flag it.
  for (const source of SAMPLES) {
    for (let offset = 0; offset <= source.length; offset++) {
      const expected = source.slice(0, offset).split('\n');
      expected.pop();
      expected.reverse();
      assert.deepEqual(
        [...linesAbove(source, offset)], expected,
        `source ${JSON.stringify(source)} at offset ${offset}`
      );
    }
  }
});

test('linesAbove terminates when the file starts with a newline', () => {
  // lastIndexOf clamps a negative start to 0, so a naive loop finds the
  // newline at index 0 forever. An index that never finishes is the worst
  // possible failure for a file that merely begins with a blank line.
  assert.deepEqual([...linesAbove('\n\nx', 3)], ['', '']);
});

test('trimEndIndex agrees with the regex it replaced', () => {
  const sources = [...SAMPLES, 'tail  \t\n\r\n', 'nbsp  ﻿', '   ', 'no-trailing'];
  for (const source of sources) {
    for (let end = 0; end <= source.length; end++) {
      assert.equal(
        source.slice(0, trimEndIndex(source, end)),
        source.slice(0, end).replace(/\s*$/, ''),
        `source ${JSON.stringify(source)} at ${end}`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function writeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-par-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

/** Index `root` into its own database and return everything that was written. */
async function indexInto(root, name, { workers, poolThreshold }) {
  const config = {
    ...DEFAULTS, root, workers,
    dir: path.join(root, '.cgraph'),
    db: path.join(root, '.cgraph', `${name}.db`),
    deps: { ...DEFAULTS.deps, offline: true },
  };
  const store = await Store.open(config.db);
  const registry = await PackRegistry.load(config);
  try {
    const stats = await new Indexer({ store, config, registry, poolThreshold }).run({});
    const dump = {
      files: store.all('SELECT id, path, lang, pack, hash, size, loc, tok, parsed, skip_reason FROM files ORDER BY id'),
      nodes: store.all(
        `SELECT id, file_id, parent_id, kind, name, qname, start_line, end_line,
                signature, doc, visibility, is_exported, tok, rank FROM nodes ORDER BY id`
      ),
      edges: store.all('SELECT src_id, dst_id, ext_id, kind, confidence, file_id, line FROM edges ORDER BY id'),
      imports: store.all('SELECT file_id, spec, symbol, alias, line, resolved_file_id FROM imports ORDER BY id'),
      unresolved: store.all('SELECT file_id, line, name, kind, reason FROM unresolved ORDER BY id'),
    };
    return { stats, dump, gaps: registry.gaps().sort(), poolOpen: !!registry.pool };
  } finally {
    store.close();
    registry.dispose();
  }
}

function withHome(root, fn) {
  // Same redirection as test/fixture.js: never touch the developer's ~/.cgraph.
  // Parser threads inherit the environment at spawn, so they see it too.
  const prior = process.env.CGRAPH_HOME;
  process.env.CGRAPH_HOME = path.join(root, '.cache');
  return fn().finally(() => {
    if (prior === undefined) delete process.env.CGRAPH_HOME;
    else process.env.CGRAPH_HOME = prior;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* AV may hold WAL files */ }
  });
}

/** Enough files for several batches, in several languages, with cross-file calls. */
function mixedRepo() {
  const files = { 'package.json': '{"name":"demo"}' };
  for (let i = 0; i < 150; i++) {
    const next = (i + 1) % 150;
    files[`src/m${i}.js`] =
      `import { f${next} } from './m${next}.js';\n\n` +
      `/** Doc for f${i}. */\n` +
      `export function f${i}(x) { return helper(x) + f${next}(x); }\n\n` +
      // The same name in every file: resolution has to break the tie, and the
      // tie-break depends on node order — which is what must not vary.
      `function helper(x) { return x + ${i}; }\n`;
  }
  files['src/svc.ts'] =
    `/**\n * Loads a user.\n * @param id the id\n */\nexport async function loadUser(id: string): Promise<string> {\n  return id;\n}\n`;
  // Python in a repo whose manifests only announce JavaScript: its pack is
  // loaded lazily, on first sight, which a pooled run must still get right.
  files['tools/gen.py'] = 'def generate(n):\n    """Make n things."""\n    return [n]\n';
  // A language with a grammar but no queries: recorded as a gap, not parsed.
  files['native/core.c'] = 'int add(int a, int b) { return a + b; }\n';
  files['README.md'] = '# demo\n';
  return files;
}

// ---------------------------------------------------------------------------
// parser threads
// ---------------------------------------------------------------------------

test('a pooled index writes the same rows, with the same ids, as a single-threaded one', opts, async () => {
  const root = writeRepo(mixedRepo());
  await withHome(root, async () => {
    const inline = await indexInto(root, 'inline', { workers: 1, poolThreshold: 0 });
    const pooled = await indexInto(root, 'pooled', { workers: 3, poolThreshold: 0 });

    assert.equal(inline.stats.workers, 1, 'workers: 1 never starts a pool');
    assert.equal(pooled.stats.workers, 3, 'the pool actually ran — otherwise this test proves nothing');
    assert.ok(pooled.dump.nodes.length > 300, 'the fixture produced a real graph');

    // Ids included on purpose. Batches finish out of order on a pool; they
    // must still be written in dispatch order, or the INFERRED edge chosen for
    // an ambiguous name would differ from run to run.
    for (const table of Object.keys(inline.dump)) {
      assert.deepEqual(pooled.dump[table], inline.dump[table], `${table} differ between pooled and inline`);
    }

    for (const key of ['seen', 'added', 'parsed', 'skipped', 'failed', 'tokens', 'bytes']) {
      assert.equal(pooled.stats[key], inline.stats[key], `stats.${key}`);
    }
    assert.deepEqual(pooled.gaps, inline.gaps, 'languages without queries are reported the same way');
    assert.ok(pooled.gaps.includes('c'), 'the gap is still recorded when the main thread never parses');
    assert.equal(pooled.poolOpen, false, 'threads are released when the run ends');

    const doc = pooled.dump.nodes.find((n) => n.name === 'loadUser');
    assert.equal(doc.doc, 'Loads a user.', 'pack hooks ran in the worker');
    assert.ok(pooled.dump.nodes.some((n) => n.name === 'generate'), 'a lazily-loaded pack parsed its file');
  });
});

test('a small run parses on the main thread even when threads are allowed', opts, async () => {
  // The MCP server re-indexes before answering. Spawning threads for a
  // three-file update would add more latency than the parsing it saves.
  const root = writeRepo({
    'package.json': '{"name":"demo"}',
    'a.js': 'export function a() { return 1; }\n',
  });
  await withHome(root, async () => {
    const run = await indexInto(root, 'small', { workers: 8, poolThreshold: undefined });
    assert.equal(run.stats.workers, 1);
    assert.equal(run.stats.parsed, 2);
  });
});

test('a batch whose parser thread is lost is parsed on the main thread instead', opts, async () => {
  // Degrade, don't crash: a pack that kills its worker must cost speed, not
  // files. Without the fallback the whole batch would be recorded as failed.
  const root = writeRepo({
    'package.json': '{"name":"demo"}',
    'a.js': '/** Says hi. */\nexport function hello() { return 1; }\n',
  });
  await withHome(root, async () => {
    const config = {
      ...DEFAULTS, root,
      dir: path.join(root, '.cgraph'),
      db: path.join(root, '.cgraph', 'index.db'),
      deps: { ...DEFAULTS.deps, offline: true },
    };
    const registry = await PackRegistry.load(config);
    try {
      assert.equal(await registry.openPool(2), 2);
      registry.pool.run = () => Promise.reject(new Error('parser thread exited (code 1)'));

      const content = fs.readFileSync(path.join(root, 'a.js'), 'utf8');
      const [result] = await registry.parseBatch([
        { file: { rel: 'a.js', content }, lang: registry.detect('a.js', content), tok: 0 },
      ]);
      assert.equal(result.error, null);
      assert.ok(result.extraction.nodes.some((n) => n.name === 'hello' && n.doc === 'Says hi.'));
    } finally {
      await registry.closePool();
      registry.dispose();
    }
  });
});

test('a registry not built by load() declines to pool rather than guessing', async () => {
  // Workers rebuild the registry from config. One assembled by hand (as some
  // tests and embedders do) cannot be rebuilt, so it must stay single-threaded.
  const registry = new PackRegistry({ config: {}, packs: new Map(), host: { dispose() {} } });
  assert.equal(await registry.openPool(4), 0);
  assert.equal(registry.pool ?? null, null);
});

// ---------------------------------------------------------------------------
// doc comments on a large file
// ---------------------------------------------------------------------------

test('doc comments are found throughout a large file', opts, async () => {
  // 1,500 documented functions in one file. The old lookup rescanned
  // everything above each one; correct, but quadratic. This pins the answers
  // at the top, middle and bottom so a faster lookup cannot quietly start
  // returning the wrong comment — or none — deep into a file.
  let ts = '';
  for (let i = 0; i < 1500; i++) {
    ts += `/**\n * Summary ${i}.\n * @returns a number\n */\nexport   async function fn${i}(a: number): Promise<number> {\n  return a + ${i};\n}\n\n\n`;
  }
  const root = writeRepo({ 'package.json': '{"name":"demo"}', 'tsconfig.json': '{}', 'big.ts': ts });
  await withHome(root, async () => {
    const run = await indexInto(root, 'big', { workers: 1, poolThreshold: 0 });
    const docOf = (name) => run.dump.nodes.find((n) => n.name === name)?.doc;
    for (const i of [0, 1, 749, 1498, 1499]) {
      assert.equal(docOf(`fn${i}`), `Summary ${i}.`, `fn${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// progress
// ---------------------------------------------------------------------------

/** Drive a Progress as if on a terminal and return everything it drew. */
function capture(fn) {
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return written.join('');
}

test('Progress draws a bar and percentage once a phase knows its size', () => {
  const p = new Progress('  indexing');
  p.quiet = false;   // the test process is piped; pretend it is a terminal
  const drawn = capture(() => {
    p.phase('indexing', { total: 200, work: 1000 });
    p.last = 0;
    p.tick(50, 'src/deep/file.js', 250);
  });
  assert.match(drawn, /indexing/);
  assert.match(drawn, /25%/, 'percentage follows work done, not item count');
  assert.match(drawn, /50\/200/);
  assert.match(drawn, /file\.js/);
  assert.ok(drawn.startsWith('\r'), 'redraws in place');
});

test('Progress without a known size just counts, as before', () => {
  const p = new Progress('scanning');
  p.quiet = false;
  const drawn = capture(() => { p.tick(1234, 'a.js'); });
  assert.match(drawn, /scanning\s+1,234/);
  assert.ok(!drawn.includes('%'), 'no percentage is invented for an open-ended phase');
});

test('Progress phases stay silent when piped', () => {
  const p = new Progress('indexing');
  assert.equal(p.quiet, true);
  const drawn = capture(() => {
    p.phase('resolving');
    p.update(10, 100);
    p.tick(1, 'x', 5);
    p.done();
  });
  assert.equal(drawn, '', 'no control characters reach a pipe or a log file');
});

test('phaseSummary reports where the time went and omits what did not matter', () => {
  assert.equal(
    phaseSummary({ phases: { scan: 400, index: 6100, resolve: 20, rank: 250 }, workers: 8 }),
    'scan 400ms  ·  parse 6.1s (8 threads)  ·  rank 250ms'
  );
  assert.equal(phaseSummary({ phases: { scan: 1, index: 300, resolve: 0, rank: 0 }, workers: 1 }), 'parse 300ms');
  assert.equal(phaseSummary({}), '');
  assert.equal(count(1234567), '1,234,567');
});

// ---------------------------------------------------------------------------
// lazily loaded packs
// ---------------------------------------------------------------------------

test('a language served by a differently-named pack loads on first sight', opts, async () => {
  // A Python project with a small TypeScript front end. Its manifests announce
  // only Python, so the typescript pack loads lazily — and `tsx` is not the
  // name of a pack, it is a language the typescript pack serves. Looking for a
  // pack called `tsx` found nothing and marked the language unavailable for
  // the rest of the run; whether App.tsx got symbols then depended on whether
  // the walk happened to reach a .ts file first. Here it does not.
  const root = writeRepo({
    'requirements.txt': 'flask\n',
    'app.py': 'def main():\n    return 1\n',
    'ui/App.tsx': 'export function App() { return <div/>; }\n',
    'ui/util.ts': 'export function util() { return 1; }\n',
  });
  await withHome(root, async () => {
    const run = await indexInto(root, 'tsx', { workers: 1, poolThreshold: 0 });
    const file = run.dump.files.find((f) => f.path === 'ui/App.tsx');
    assert.equal(file.parsed, 1, `App.tsx was skipped: ${file.skip_reason}`);
    assert.ok(run.dump.nodes.some((n) => n.name === 'App'));
    assert.ok(!run.gaps.includes('tsx'), 'and it is not reported as a language without queries');
  });
});

test('loading a pack lazily does not look like the packs changed', opts, async () => {
  // The fingerprint used to cover whichever packs were loaded at that moment.
  // A builtin loads lazily on first sight of its language, so the fingerprint
  // at the end of a run differed from the one stored at its start — and the
  // next run, seeing a mismatch, re-read every file it had skipped for lack of
  // queries and re-resolved the entire graph. In the MCP server that was a
  // second full pass after every real change; between the CLI and the server
  // it never settled at all.
  const root = writeRepo({
    'requirements.txt': 'flask\n',
    'app.py': 'def main():\n    return helper()\n\ndef helper():\n    return 1\n',
    'tool.js': 'export function tool() { return 1; }\n',
    'native/core.c': 'int add(int a, int b) { return a + b; }\n',
  });
  await withHome(root, async () => {
    const config = {
      ...DEFAULTS, root,
      dir: path.join(root, '.cgraph'),
      db: path.join(root, '.cgraph', 'index.db'),
      deps: { ...DEFAULTS.deps, offline: true },
    };
    const store = await Store.open(config.db);
    const registry = await PackRegistry.load(config);
    try {
      const before = registry.fingerprint();
      const first = await new Indexer({ store, config, registry }).run({});
      assert.ok(first.parsed >= 2, 'the javascript pack was loaded lazily and used');
      assert.equal(registry.fingerprint(), before, 'the fingerprint describes what is on disk, not what is loaded');

      // Same process (a server refreshing), nothing changed on disk.
      const second = await new Indexer({ store, config, registry }).run({});
      assert.equal(second.unchanged, first.seen, 'every file is recognised as unchanged');
      assert.equal(second.resolution, undefined, 'and the graph is not resolved again');

      // A new process (the CLI) that has not lazily loaded anything yet.
      const fresh = await PackRegistry.load(config);
      try {
        assert.equal(fresh.fingerprint(), before);
      } finally { fresh.dispose(); }
    } finally {
      store.close();
      registry.dispose();
    }
  });
});
