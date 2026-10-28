/**
 * Programmatic API tests.
 *
 * The public entry points are part of the package contract: `cgraph` and
 * `cgraph/sdk` are declared in `exports`, so breaking them breaks consumers
 * silently at import time. These tests import them exactly as an installed
 * package would.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { openProject } from '../src/index.js';
import { Store } from '../src/core/store.js';
import { Indexer } from '../src/core/indexer.js';
import { PackRegistry } from '../src/packs/registry.js';
import { loadConfig, DEFAULTS } from '../src/core/config.js';
import { outlineFile, readSymbol, findSymbol } from '../src/core/retrieve.js';
import { buildFixture } from './fixture.js';

const require = createRequire(import.meta.url);
const skip = (() => {
  try { require.resolve('tree-sitter-wasms/package.json'); return false; }
  catch { return true; }
})();
const opts = { skip };

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-api-'));
  const files = {
    'package.json': '{"name":"demo"}',
    'src/db.js': 'export function findUser(id) { return id; }\n',
    'src/auth.js': "import { findUser } from './db';\nexport function handleLogin(e) { return findUser(e); }\n",
    'src/api.js': "import { handleLogin } from './auth';\nexport function postLogin(r) { return handleLogin(r); }\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

/**
 * A repo + open store + registry, WITHOUT running an index, so a test can drive
 * Indexer.run() itself (dryRun, batch flush, parse-error). Mirrors fixture.js's
 * config setup and CGRAPH_HOME redirection; cleanup is best-effort because the
 * Windows AV scanner can hold WAL sidecars open after close().
 */
async function openRaw(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-api-raw-'));
  const priorHome = process.env.CGRAPH_HOME;
  process.env.CGRAPH_HOME = path.join(root, '.cache');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const config = {
    ...DEFAULTS, root,
    dir: path.join(root, '.cgraph'),
    db: path.join(root, '.cgraph', 'index.db'),
    deps: { ...DEFAULTS.deps, offline: true },
  };
  const store = await Store.open(config.db);
  const registry = await PackRegistry.load(config);
  return {
    root, store, registry, config,
    // Minimal node lookup mirroring test/fixture.js: name -> row, or null.
    node(name) {
      return store.get(
        `SELECT n.*, f.path FROM nodes n JOIN files f ON f.id = n.file_id
          WHERE n.name = ? ORDER BY n.rank DESC LIMIT 1`,
        name
      ) ?? null;
    },
    cleanup() {
      try { store.close(); } catch { /* already closed */ }
      try { registry.dispose(); } catch { /* noop */ }
      if (priorHome === undefined) delete process.env.CGRAPH_HOME;
      else process.env.CGRAPH_HOME = priorHome;
      try {
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20, retryOnEperm: true });
      } catch { /* cleanup only */ }
    },
  };
}

test('the package entry point exports its documented surface', async () => {
  const api = await import('../src/index.js');
  for (const name of [
    'openProject', 'loadConfig', 'Store', 'Indexer', 'PackRegistry',
    'outlineFile', 'findSymbol', 'readSymbol', 'graph', 'estimate',
  ]) {
    assert.ok(api[name], `'${name}' should be exported from the package root`);
  }
});

test('the sdk entry point exports its documented surface', async () => {
  const sdk = await import('../src/sdk/index.js');
  for (const name of [
    'definePack', 'validatePack', 'makeTestContext', 'CAPTURES',
    'tryCandidates', 'normalizeRelative', 'splitIdentifier', 'EXACT', 'INFERRED',
  ]) {
    assert.ok(sdk[name], `'${name}' should be exported from cgraph/sdk`);
  }
});

test('openProject indexes and answers queries', opts, async () => {
  const root = makeRepo();
  const project = await openProject(root);
  try {
    const stats = await project.index();
    assert.ok(stats.parsed >= 3, 'all source files indexed');

    const hits = project.find('findUser');
    assert.equal(hits[0].node.name, 'findUser');

    const read = project.read('findUser');
    assert.match(read.lines.join('\n'), /export function findUser/);

    const callers = project.callers('findUser');
    assert.ok(callers.some((c) => c.qname.includes('handleLogin')));

    const impact = project.impact('findUser', { depth: 3 });
    assert.ok(impact.nodes.some((n) => n.qname.includes('postLogin')), 'transitive');

    const route = project.path('postLogin', 'findUser');
    assert.equal(route.length, 3, 'postLogin -> handleLogin -> findUser');
  } finally {
    project.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('map works for a file and for the repo', opts, async () => {
  const root = makeRepo();
  const project = await openProject(root);
  try {
    await project.index();

    const file = project.map('src/db.js');
    assert.match(file.lines.join('\n'), /findUser/);

    const repo = project.map();
    assert.match(repo.lines.join('\n'), /src/);
  } finally {
    project.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('queries for a missing symbol return empty rather than throwing', opts, async () => {
  // A library consumer should be able to probe without try/catch around
  // every call.
  const root = makeRepo();
  const project = await openProject(root);
  try {
    await project.index();
    assert.equal(project.read('nothingHere'), null);
    assert.deepEqual(project.callers('nothingHere'), []);
    assert.deepEqual(project.impact('nothingHere').nodes, []);
    assert.equal(project.path('nothingHere', 'alsoMissing'), null);
  } finally {
    project.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stats include the savings ledger', opts, async () => {
  const root = makeRepo();
  const project = await openProject(root);
  try {
    await project.index();
    const stats = project.stats();
    assert.ok(stats.nodes > 0);
    assert.ok(stats.edges > 0);
    assert.ok(stats.counters, 'counters are exposed for reporting');
  } finally {
    project.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('openProject refuses a missing index when create is false', opts, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-api-none-'));
  try {
    await assert.rejects(
      () => openProject(root, { create: false }),
      /cgraph init/,
      'the error should say how to fix it'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('outlineFile on a file with no symbols reports it explicitly', opts, async () => {
  // The "(no symbols extracted)" branch. An outline that returned only a header
  // would read as an empty file; the explicit marker tells the agent the file
  // exists but yielded nothing, so it does not stop looking.
  const fx = await buildFixture({ 'data/notes.md': '# Notes\nsome text\n' });
  try {
    const file = fx.store.getFileByPath('data/notes.md');
    assert.ok(file, 'markdown file is indexed (as a stub, lang not parsed)');
    const out = outlineFile(fx.store, file);
    assert.match(out.lines.join('\n'), /\(no symbols extracted\)/);
  } finally {
    fx.cleanup();
  }
});

test('readSymbol in signature mode returns the header, doc and signature only', opts, async () => {
  // The mode==='signature' branch — it never touches the filesystem, so it is
  // the cheap "what is this symbol" answer. Assert no body lines leak in.
  const fx = await buildFixture({
    'src/a.js': '/**\n * Authenticates a user.\n */\nexport function handleLogin(email) {\n  return email;\n}\n',
  });
  try {
    const node = fx.node('handleLogin');
    const sig = readSymbol(fx.store, fx.root, node, { mode: 'signature' });
    const text = sig.lines.join('\n');
    assert.match(text, /handleLogin/);
    assert.match(text, /Authenticates a user/);
    // The body (`return email`) must NOT appear in signature mode.
    assert.doesNotMatch(text, /return email/);
  } finally {
    fx.cleanup();
  }
});

test('readSymbol reports an unreadable file instead of throwing', opts, async () => {
  // The fs.readFileSync catch. Bodies are sliced from disk by offset; if the
  // source file is gone (deleted, moved, permission), the agent is told the
  // index may be stale rather than the tool crashing.
  const fx = await buildFixture({
    'src/a.js': 'export function vanish() { return 1; }\n',
  });
  try {
    const node = fx.node('vanish');
    fs.rmSync(path.join(fx.root, 'src', 'a.js'));
    const out = readSymbol(fx.store, fx.root, node);
    assert.match(out.lines.join('\n'), /file unreadable/);
  } finally {
    fx.cleanup();
  }
});

test('readSymbol falls back to a line slice when the on-disk file shrank', opts, async () => {
  // The `stale` branch: source.length < node.end_byte. A file edited since
  // indexing invalidates byte offsets; slicing by line keeps the answer roughly
  // right and warns about staleness, instead of returning bytes from the middle
  // of unrelated code.
  const fx = await buildFixture({
    'src/a.js': 'export function shrink() {\n  return 1;\n}\n',
  });
  try {
    const node = fx.node('shrink');
    const original = fx.store.getFileByPath('src/a.js');
    // Truncate the file below the stored end_byte so the byte slice is out of
    // range. Re-stub the file row's bytes are irrelevant here; readSymbol only
    // reads the file from disk.
    fs.writeFileSync(path.join(fx.root, 'src', 'a.js'), 'x');
    assert.ok(node.end_byte > 1, 'node end_byte is past the truncated file');
    void original;
    const out = readSymbol(fx.store, fx.root, node);
    const text = out.lines.join('\n');
    assert.match(text, /index is stale/, 'staleness is announced, not silent');
  } finally {
    fx.cleanup();
  }
});

test('indexer dryRun counts files and writes nothing', opts, async () => {
  // The dryRun file-push path: stats.files is populated, the store is not.
  // A user previewing "what would be indexed" must not mutate the graph.
  const fx = await openRaw({
    'package.json': '{"name":"demo"}',
    'src/a.js': 'export function one() { return 1; }\n',
    'src/b.js': 'export function two() { return 2; }\n',
  });
  try {
    const indexer = new Indexer({ store: fx.store, config: fx.config, registry: fx.registry });
    const stats = await indexer.run({ dryRun: true });
    assert.equal(stats.seen, 3, 'package.json + both source files counted');
    assert.equal(stats.files.length, 3, 'dryRun fills the file list, one entry per file');
    assert.ok(stats.files.every((f) => f.lang), 'every listed file has a detected language');
    assert.ok(stats.files.some((f) => f.path === 'src/a.js' && f.tok > 0), 'source file listed with a token estimate');
    assert.equal(fx.store.stats().files, 0, 'dryRun wrote no file rows');
  } finally {
    fx.cleanup();
  }
});

test('indexer flushes mid-loop on a >64-file batch', opts, async () => {
  // The `pending.length >= 64` flush branch. Memory stays flat on big repos by
  // flushing every 64 files; the loop must survive several flushes and a final
  // tail flush, and persist every file.
  const files = { 'package.json': '{"name":"demo"}' };
  for (let i = 0; i < 70; i++) {
    files[`src/f${i}.js`] = `export function f${i}() { return ${i}; }\n`;
  }
  const fx = await openRaw(files);
  try {
    const indexer = new Indexer({ store: fx.store, config: fx.config, registry: fx.registry });
    const stats = await indexer.run({});
    // 70 source files + package.json (json pack) all land in `added`.
    assert.equal(stats.added, 71, 'all files indexed across multiple flushes');
    assert.equal(fx.store.stats().files, 71, 'every file persisted, none lost at a flush boundary');
    assert.ok(fx.node('f0') && fx.node('f69'), 'first and last survive the batch flushes');
  } finally {
    fx.cleanup();
  }
});

test('indexer records a file that fails to parse and keeps going', opts, async () => {
  // The parse-error persist path (degrade, don't crash). A project-local pack
  // overrides the builtin javascript pack with a .scm that fails to compile, so
  // host.query throws per file; parseBatch captures it, the indexer counts it as
  // failed and persists a stub, and the index completes without throwing.
  const fx = await openRaw({
    // No package.json: the broken pack only overrides javascript, and the json
    // pack would parse it cleanly and pollute stats.parsed.
    'src/a.js': 'export function a() { return 1; }\n',
    'src/b.js': 'export function b() { return 2; }\n',
    // The pack's query references a node type the grammar does not define, so
    // tree-sitter rejects it at compile time -> parseBatch error -> indexer's
    // `if (error)` persist branch.
    '.cgraph/packs/broken/index.js':
      "import { fileURLToPath } from 'node:url';\n" +
      'export default { id: "javascript", queries: { tags: fileURLToPath(new URL("./broken.scm", import.meta.url)) } };\n',
    '.cgraph/packs/broken/broken.scm':
      '(this_node_type_does_not_exist) @definition.function\n',
  });
  try {
    const indexer = new Indexer({ store: fx.store, config: fx.config, registry: fx.registry });
    const stats = await indexer.run({});
    assert.ok(stats.failed >= 1, 'the broken-language files are counted as failed');
    const row = fx.store.getFileByPath('src/a.js');
    assert.equal(row.parsed, 0, 'a parse-error file is persisted as an unparsed stub');
    assert.match(row.skip_reason, /parse-error/, 'the stub records why it failed');
    assert.equal(stats.parsed, 0, 'no file produced symbols');
    // Reaching this line at all proves the run did not abort — the contract.
  } finally {
    fx.cleanup();
  }
});

test('indexer._flush with no registry persists file rows (P0 path)', opts, async () => {
  // The `if (!this.registry)` branch in _flush: pack-less / P0 indexing records
  // a file row per entry via _persistFileRow, with no symbol extraction.
  // run() never reaches this branch with registry=null — every file is counted
  // as 'no-language' and persisted as a stub before pending is filled — so the
  // branch is exercised directly with a synthetic batch.
  const fx = await openRaw({
    'package.json': '{"name":"demo"}',
    'src/a.js': 'export function a() { return 1; }\n',
  });
  try {
    const indexer = new Indexer({ store: fx.store, config: fx.config, registry: null });
    const batch = [
      {
        file: {
          rel: 'src/a.js',
          hash: 'deadbeef',
          mtime: 1700000000000,
          size: 30,
          content: 'export function a() { return 1; }\n',
          subproject: null,
        },
        lang: { id: 'javascript', pack: 'javascript' },
        tok: 8,
      },
    ];
    const stats = { parsed: 0, failed: 0, skipped: 0, bySkip: new Map() };
    await indexer._flush(batch, stats);
    const row = fx.store.getFileByPath('src/a.js');
    assert.ok(row, 'file row persisted by the P0 _flush path');
    assert.equal(row.parsed, 0, 'no symbols extracted on the P0 path');
    assert.equal(row.lang, 'javascript', 'the lang id is recorded on the row');
    assert.equal(fx.store.stats().nodes, 0, 'no nodes without a registry');
    assert.equal(stats.parsed, 0, 'P0 _flush never counts a file as parsed');
  } finally {
    fx.cleanup();
  }
});

test('CGRAPH_OFFLINE=1 forces deps.offline in the loaded config', () => {
  // The config.js offline env branch (the network gate). A user who exports
  // CGRAPH_OFFLINE=1 must get deps.offline=true regardless of file defaults,
  // so grammar downloads never happen on an air-gapped machine.
  const prior = process.env.CGRAPH_OFFLINE;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-cfg-'));
  try {
    process.env.CGRAPH_OFFLINE = '1';
    const config = loadConfig(root, { root });
    assert.equal(config.deps.offline, true, 'env forces offline');
  } finally {
    if (prior === undefined) delete process.env.CGRAPH_OFFLINE;
    else process.env.CGRAPH_OFFLINE = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed .cgraph/config.json is reported with a clear error', () => {
  // The config.js JSON.parse catch. A hand-edited config with a typo must not
  // crash opaquely — the message names the file so the user can fix it.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-cfg-'));
  try {
    fs.mkdirSync(path.join(root, '.cgraph'), { recursive: true });
    fs.writeFileSync(path.join(root, '.cgraph', 'config.json'), '{ not valid json,,, }');
    assert.throws(
      () => loadConfig(root, { root }),
      /Invalid .*config\.json/,
      'the error names the offending file'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
