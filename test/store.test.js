/**
 * Store tests.
 *
 * The delete-then-insert contract is the one that matters most: incremental
 * updates re-index a file dozens of times per session, and a leak in
 * `clearFileData` shows up as duplicate symbols and phantom edges that are very
 * hard to trace back to their cause.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/core/store.js';
import { SCHEMA_VERSION } from '../src/core/schema.js';

async function fixture() {
  const store = await Store.memory();
  const fileId = store.upsertFile({
    path: 'src/a.js', lang: 'javascript', pack: 'javascript',
    hash: 'h1', mtime: 1, size: 10, loc: 3, tok: 5, parsed: 1,
  });
  return { store, fileId };
}

test('migrations bring a fresh database to the current schema version', async () => {
  const store = await Store.memory();
  assert.equal(Number(store.getMeta('schema_version')), SCHEMA_VERSION);
  store.close();
});

test('migrations are idempotent across reopens', async () => {
  const store = await Store.memory();
  store.migrate();
  store.migrate();
  assert.equal(Number(store.getMeta('schema_version')), SCHEMA_VERSION);
  store.close();
});

test('upsertFile round-trips subproject', async () => {
  const store = await Store.memory();
  store.upsertFile({
    path: 'frontend/src/a.ts', lang: 'typescript', pack: 'typescript',
    hash: 'h1', mtime: 1, size: 10, loc: 3, tok: 5, parsed: 1,
    subproject: 'frontend',
  });
  assert.equal(store.getFileByPath('frontend/src/a.ts').subproject, 'frontend');
  assert.deepEqual(store.listSubprojects(), ['frontend']);
  store.close();
});

test('listSubprojects ignores files with no subproject', async () => {
  const { store } = await fixture(); // subproject omitted
  assert.deepEqual(store.listSubprojects(), []);
  store.close();
});

test('a migration with forceReindex sets needsFullReindex only on the crossing call', async () => {
  // Store.memory() is always a fresh database, so every migration — including
  // the v3 'subprojects' migration, which is marked forceReindex — runs on
  // this very call.
  const fresh = await Store.memory();
  assert.equal(fresh.needsFullReindex, true, 'crossing the migration sets the flag');
  fresh.close();

  // A file-backed database already at the current version, on the other
  // hand, must not re-set it on a later open: the migration loop skips any
  // version already applied, so the forceReindex branch never runs again.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-store-')), 'index.db');
  const first = await Store.open(file);
  assert.equal(first.needsFullReindex, true);
  first.close();

  const second = await Store.open(file);
  assert.equal(second.needsFullReindex, false, 'reopening an up-to-date database must not force a reindex');
  second.close();
});

test('upsertFile inserts once and updates in place', async () => {
  const { store } = await fixture();
  store.upsertFile({
    path: 'src/a.js', lang: 'javascript', pack: 'javascript',
    hash: 'h2', mtime: 2, size: 20, loc: 4, tok: 6, parsed: 1,
  });
  assert.equal(store.stats().files, 1, 'same path must not create a second row');
  assert.equal(store.getFileByPath('src/a.js').hash, 'h2');
  store.close();
});

test('clearFileData removes nodes, edges, imports and search rows', async () => {
  const { store, fileId } = await fixture();

  store.run(
    `INSERT INTO nodes(file_id, kind, name, qname, start_line, end_line, start_byte, end_byte)
     VALUES(?, 'function', 'foo', 'src/a.js::foo', 1, 3, 0, 20)`,
    fileId
  );
  const nodeId = store.get('SELECT id FROM nodes').id;

  store.run(
    `INSERT INTO edges(src_id, dst_id, kind, confidence, file_id, line)
     VALUES(?, ?, 'calls', 'EXACT', ?, 2)`,
    nodeId, nodeId, fileId
  );
  store.run(
    `INSERT INTO imports(file_id, spec, alias, line) VALUES(?, './b', 'b', 1)`,
    fileId
  );
  store.run(
    `INSERT INTO unresolved(file_id, line, name, reason) VALUES(?, 2, 'mystery', 'no-import')`,
    fileId
  );
  store.indexNodeForSearch(nodeId, { name: 'foo', qname: 'src/a.js::foo' });

  const before = store.stats();
  assert.equal(before.nodes, 1);
  assert.equal(before.edges, 1);

  store.clearFileData(fileId);

  const after = store.stats();
  assert.equal(after.nodes, 0, 'nodes cleared');
  assert.equal(after.edges, 0, 'edges cleared');
  assert.equal(after.unresolved, 0, 'unresolved cleared');
  assert.equal(store.get('SELECT COUNT(*) n FROM imports').n, 0, 'imports cleared');
  assert.equal(store.get('SELECT COUNT(*) n FROM trigrams').n, 0, 'trigrams cleared');

  // The FTS tables only exist on a build whose SQLite was compiled with FTS5.
  if (store.hasFts5) {
    assert.equal(store.get('SELECT COUNT(*) n FROM fts_map').n, 0, 'fts map cleared');
    assert.equal(store.get('SELECT COUNT(*) n FROM symbols_fts').n, 0, 'fts index cleared');
  }

  assert.equal(after.files, 1, 'the file row itself survives');

  store.close();
});

test('removeFile deletes the file row too', async () => {
  const { store, fileId } = await fixture();
  store.removeFile(fileId);
  assert.equal(store.stats().files, 0);
  store.close();
});

test('foreign keys cascade from files to nodes', async () => {
  const { store, fileId } = await fixture();
  store.run(
    `INSERT INTO nodes(file_id, kind, name, qname, start_line, end_line, start_byte, end_byte)
     VALUES(?, 'function', 'foo', 'q', 1, 2, 0, 5)`,
    fileId
  );
  store.run('DELETE FROM files WHERE id = ?', fileId);
  assert.equal(store.stats().nodes, 0, 'deleting a file must not orphan its nodes');
  store.close();
});

test('counters accumulate additively', async () => {
  const store = await Store.memory();
  store.bumpCounters({ 'total.tokens_returned': 100 });
  store.bumpCounters({ 'total.tokens_returned': 250 });
  assert.equal(store.counters('total.')['total.tokens_returned'], '350');
  store.close();
});

test('transactions roll back on failure', async () => {
  const { store, fileId } = await fixture();
  assert.throws(() => {
    store.transaction(() => {
      store.run(
        `INSERT INTO nodes(file_id, kind, name, qname, start_line, end_line, start_byte, end_byte)
         VALUES(?, 'function', 'foo', 'q', 1, 2, 0, 5)`,
        fileId
      );
      throw new Error('boom');
    });
  }, /boom/);
  assert.equal(store.stats().nodes, 0, 'the partial insert must not survive');
  store.close();
});

test('nested transactions join the outer one', async () => {
  const { store, fileId } = await fixture();
  store.transaction(() => {
    store.transaction(() => {
      store.run(
        `INSERT INTO nodes(file_id, kind, name, qname, start_line, end_line, start_byte, end_byte)
         VALUES(?, 'function', 'inner', 'q', 1, 2, 0, 5)`,
        fileId
      );
    });
  });
  assert.equal(store.stats().nodes, 1);
  store.close();
});

test('insertNode makes a symbol findable by its camelCase component words', async () => {
  const { store, fileId } = await fixture();
  const nodeId = store.insertNode({
    fileId, kind: 'function', name: 'handleLogin', qname: 'src/a.js::handleLogin',
    startLine: 1, endLine: 9, startByte: 0, endByte: 100,
    signature: 'handleLogin(email: string)', doc: 'Authenticates a user.',
  });

  // This exercises the FTS5 index directly, so it can only run where FTS5
  // exists. The equivalent behaviour on builds without it is covered by the
  // 'without FTS5' tests in search.test.js, which go through search() instead.
  if (!store.hasFts5) {
    store.close();
    return;
  }

  // The whole point of the `parts` column: a developer searching 'login' must
  // find 'handleLogin', which plain FTS5 word tokenization cannot do.
  const byWord = store.get(
    `SELECT m.node_id FROM symbols_fts f JOIN fts_map m ON m.rowid = f.rowid
     WHERE symbols_fts MATCH 'login'`
  );
  assert.equal(byWord?.node_id, nodeId, "'login' should match 'handleLogin'");

  const byFull = store.get(
    `SELECT m.node_id FROM symbols_fts f JOIN fts_map m ON m.rowid = f.rowid
     WHERE symbols_fts MATCH 'handleLogin'`
  );
  assert.equal(byFull?.node_id, nodeId, 'the raw identifier should still match');

  const byDoc = store.get(
    `SELECT m.node_id FROM symbols_fts f JOIN fts_map m ON m.rowid = f.rowid
     WHERE symbols_fts MATCH 'authenticates'`
  );
  assert.equal(byDoc?.node_id, nodeId, 'doc comments are searchable');

  store.close();
});

test('opens and indexes on a build without FTS5', async () => {
  // FTS5 is a SQLite compile-time option and Node's bundled build often omits
  // it (22.14 and 23.11 both do). Requiring it made migration fail outright
  // with "no such module: fts5", taking the whole tool down on a perfectly
  // capable Node. It must be detected, never assumed.
  const store = await Store.memory({ forceNoFts: true });
  assert.equal(store.hasFts5, false);
  assert.equal(store.getMeta('fts5'), '0');

  const fileId = store.upsertFile({
    path: 'src/a.js', lang: 'javascript', pack: 'javascript',
    hash: 'h', mtime: 1, size: 1, loc: 1, tok: 1, parsed: 1,
  });

  assert.doesNotThrow(() => {
    store.insertNode({
      fileId, kind: 'function', name: 'handleLogin', qname: 'src/a.js::handleLogin',
      startLine: 1, endLine: 5, startByte: 0, endByte: 50,
      signature: 'handleLogin(email)', doc: 'Authenticates a user.',
    });
  }, 'indexing must work without FTS5');

  assert.equal(store.stats().nodes, 1);
  // Trigrams are the always-available half of search and must still be written.
  assert.ok(store.get('SELECT node_id FROM trigrams WHERE tri = ?', 'ogi'));

  store.close();
});

test('clearFileData works without FTS5', async () => {
  const store = await Store.memory({ forceNoFts: true });
  const fileId = store.upsertFile({
    path: 'src/a.js', lang: 'javascript', pack: 'javascript',
    hash: 'h', mtime: 1, size: 1, loc: 1, tok: 1, parsed: 1,
  });
  store.insertNode({
    fileId, kind: 'function', name: 'foo', qname: 'q',
    startLine: 1, endLine: 2, startByte: 0, endByte: 5,
  });

  // Deleting FTS rows that were never created must not throw on re-index.
  assert.doesNotThrow(() => store.clearFileData(fileId));
  assert.equal(store.stats().nodes, 0);
  store.close();
});

test('trigrams support substring search that FTS5 cannot do', async () => {
  const { store, fileId } = await fixture();
  const nodeId = store.insertNode({
    fileId, kind: 'function', name: 'handleLogin', qname: 'src/a.js::handleLogin',
    startLine: 1, endLine: 9, startByte: 0, endByte: 100,
  });
  const hit = store.get('SELECT node_id FROM trigrams WHERE tri = ?', 'ogi');
  assert.equal(hit?.node_id, nodeId, "'ogi' is inside 'handleLogin' but is not a word");
  store.close();
});

test('a migration that throws is rolled back and reported with its version', async () => {
  // Covers migrate()'s catch: a migration that fails must ROLLBACK its own
  // transaction and surface "Migration N (name) failed" — not leave a
  // half-migrated database and not crash opaquely. The degrade-don't-crash
  // contract is that the user is told *which* migration broke.
  //
  // Inject the failure via SQL: migration v1 runs a bare `CREATE TABLE files`,
  // which collides with a pre-existing `files` table.
  const db = new DatabaseSync(':memory:');
  const store = new Store(db, ':memory:');
  store._configure();
  store.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  store.exec('CREATE TABLE files (id INTEGER PRIMARY KEY)'); // collides with v1
  assert.throws(() => store.migrate(), /Migration 1 \(initial\) failed/);
  store.close();
});

test('a database from a newer cgraph is refused with a clear error', async () => {
  // Covers migrate()'s post-loop version-mismatch throw. A schema_version above
  // SCHEMA_VERSION means every migration is skipped (m.version <= current), so
  // `after` stays high and must be rejected — running old code against a newer
  // schema silently corrupts the index.
  const store = await Store.memory();
  store.setMeta('schema_version', String(SCHEMA_VERSION + 100));
  assert.throws(
    () => store.migrate(),
    /does not match expected/,
    'a newer-than-known schema version must be refused'
  );
  store.close();
});

test('transaction swallows a failing rollback and rethrows the original error', async () => {
  // Covers the `catch { }` around ROLLBACK in transaction(). When fn() has
  // already ended the transaction (here by committing), the catch's ROLLBACK
  // throws "cannot start a transaction within a transaction" — that secondary
  // error must be swallowed so the caller sees the ORIGINAL failure, not a
  // confusing rollback error.
  const { store, fileId } = await fixture();
  let caught;
  try {
    store.transaction(() => {
      store.run(
        `INSERT INTO nodes(file_id, kind, name, qname, start_line, end_line, start_byte, end_byte)
         VALUES(?, 'function', 'kept', 'q', 1, 2, 0, 5)`,
        fileId
      );
      store.db.exec('COMMIT'); // end the tx so the catch's ROLLBACK has nothing to unwind
      throw new Error('post-commit failure');
    });
  } catch (err) {
    caught = err;
  }
  assert.match(caught.message, /post-commit failure/, 'the original error is rethrown, not the rollback error');
  // fn() committed the row before throwing; the swallowed rollback never ran,
  // so the write survives. This is the documented behaviour of that branch.
  assert.equal(store.stats().nodes, 1, 'the committed write is not undone by the swallowed rollback');
  store.close();
});

test('_backfillFts indexes nodes from an FTS-less build on the first FTS5 open', async () => {
  // An index built on a Node without FTS5 has nodes but no fts_map rows. On the
  // first open where FTS5 is available, ensureSearchIndex must backfill so the
  // user gets results the machine is capable of — not silently degraded search.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-store-fts-'));
  const file = path.join(dir, 'index.db');
  try {
    // Simulate the legacy, FTS-less index.
    const db = new DatabaseSync(file);
    const legacy = new Store(db, file);
    legacy._configure();
    legacy.migrate();
    legacy.ensureSearchIndex({ forceNoFts: true });
    const fileId = legacy.upsertFile({
      path: 'src/a.js', lang: 'javascript', pack: 'javascript',
      hash: 'h', mtime: 1, size: 1, loc: 1, tok: 1, parsed: 1,
    });
    legacy.insertNode({
      fileId, kind: 'function', name: 'handleLogin', qname: 'src/a.js::handleLogin',
      startLine: 1, endLine: 3, startByte: 0, endByte: 30,
    });
    // forceNoFts skips creating the FTS tables entirely — the index is nodes
    // with fts5='0', the exact state ensureSearchIndex backfills on upgrade.
    assert.equal(legacy.getMeta('fts5'), '0', 'legacy build recorded no FTS');
    legacy.close();

    // Reopen on a build WITH FTS5: the backfill must run.
    const store = await Store.open(file);
    if (!store.hasFts5) {
      // Platform without FTS5: the backfill is a no-op by design; nothing to assert.
      store.close();
      return;
    }
    assert.ok(
      store.get('SELECT COUNT(*) n FROM fts_map').n >= 1,
      'ensureSearchIndex backfilled existing nodes into FTS'
    );
    const byWord = store.get(
      `SELECT m.node_id FROM symbols_fts f JOIN fts_map m ON m.rowid = f.rowid
       WHERE symbols_fts MATCH 'login'`
    );
    assert.ok(byWord, "'login' finds 'handleLogin' only because of the backfill");
    store.close();
  } finally {
    // Best-effort: WAL leaves -wal/-shm sidecars that a Windows AV scanner can
    // hold open long after close(). A leftover OS temp dir is harmless and
    // keeps the test deterministic; the assertions have all passed by now.
    try {
      fs.rmSync(dir, {
        recursive: true, force: true,
        maxRetries: 5, retryDelay: 20, retryOnEperm: true,
      });
    } catch {
      // Ignore: cleanup only.
    }
  }
});
