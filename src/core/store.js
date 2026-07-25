/**
 * Storage layer.
 *
 * Backed by `node:sqlite`, which ships with Node >= 22.13 with FTS5 compiled in.
 * That gives us a real database with full-text search and zero dependencies and
 * zero native compilation — the single biggest reason this tool installs cleanly
 * on any platform.
 *
 * `node:sqlite` is Stability 1.2 (release candidate), so every call to it goes
 * through `openDatabase()` below. If it moves or a user is on an older Node, the
 * fallback to `better-sqlite3` is one function, not a rewrite: both expose the
 * same `prepare/run/get/all/exec` shape.
 */

import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js';
import { identifierParts, trigrams } from './identifiers.js';

/**
 * Open a SQLite database, preferring the built-in driver.
 * Returns an object with better-sqlite3-compatible ergonomics.
 */
async function openDatabase(file) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(file);
  } catch (err) {
    // Older Node, or the module moved. better-sqlite3 is API-compatible enough
    // for everything we do, so an install of it rescues the user.
    try {
      const { default: Better } = await import('better-sqlite3');
      return new Better(file);
    } catch {
      throw new Error(
        'No SQLite driver available.\n' +
          `  node:sqlite failed: ${err.message}\n` +
          '  Fix: upgrade to Node >= 22.13.0, or run `npm i better-sqlite3`.'
      );
    }
  }
}

export class Store {
  constructor(db, file) {
    this.db = db;
    this.file = file;
    this._stmts = new Map();
  }

  static async open(file, { create = true } = {}) {
    if (create) fs.mkdirSync(path.dirname(file), { recursive: true });
    else if (!fs.existsSync(file)) {
      throw new Error(`No index at ${file}. Run \`cgraph init\` first.`);
    }

    const db = await openDatabase(file);
    const store = new Store(db, file);
    store._configure();
    store.migrate();
    store.ensureSearchIndex();
    return store;
  }

  /**
   * In-memory store, for tests.
   * `forceNoFts` simulates a Node built without FTS5, which is the majority of
   * builds — the degraded path needs testing on machines that do have it.
   */
  static async memory({ forceNoFts = false } = {}) {
    const db = await openDatabase(':memory:');
    const store = new Store(db, ':memory:');
    store._configure();
    store.migrate();
    store.ensureSearchIndex({ forceNoFts });
    return store;
  }

  _configure() {
    // WAL lets the MCP server read while a watch process writes — without it,
    // every incremental update would block in-flight agent queries.
    if (this.file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA temp_store = MEMORY');
    this.db.exec('PRAGMA cache_size = -64000'); // 64 MB
  }

  /** Prepared-statement cache. Every hot path goes through here. */
  stmt(sql) {
    let s = this._stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this._stmts.set(sql, s);
    }
    return s;
  }

  run(sql, ...params) {
    return this.stmt(sql).run(...params);
  }

  get(sql, ...params) {
    return this.stmt(sql).get(...params);
  }

  all(sql, ...params) {
    return this.stmt(sql).all(...params);
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  /**
   * Run `fn` inside a transaction. Nested calls join the outer transaction
   * rather than failing, since indexing composes transactional helpers freely.
   */
  transaction(fn) {
    if (this._inTx) return fn();
    this._inTx = true;
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // A failed rollback means the transaction was already unwound.
      }
      throw err;
    } finally {
      this._inTx = false;
    }
  }

  // -- migrations ------------------------------------------------------------

  migrate() {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
    );
    const current = Number(this.getMeta('schema_version') ?? 0);

    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      this.db.exec('BEGIN');
      try {
        this.db.exec(m.up);
        this.db.exec(
          `INSERT INTO meta(key, value) VALUES('schema_version', '${m.version}')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        );
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw new Error(`Migration ${m.version} (${m.name}) failed: ${err.message}`);
      }
    }

    const after = Number(this.getMeta('schema_version') ?? 0);
    if (after !== SCHEMA_VERSION) {
      throw new Error(
        `Schema version ${after} does not match expected ${SCHEMA_VERSION}. ` +
          'The index may have been written by a newer cgraph; delete .cgraph/ and re-index.'
      );
    }
  }

  // -- optional full-text search ---------------------------------------------

  /**
   * Create the FTS5 tables if this Node binary supports them.
   *
   * FTS5 is a SQLite compile-time option and Node's bundled build is
   * inconsistent about including it: 22.14 and 23.11 ship without it, some 24.x
   * builds have it. It therefore cannot be required, only detected — and when
   * absent, search degrades to exact/prefix/trigram/LIKE rather than the tool
   * refusing to start.
   *
   * Called on every open, so a user who upgrades to a Node that has FTS5 gains
   * it automatically, with a backfill so existing symbols become searchable.
   */
  ensureSearchIndex({ forceNoFts = false } = {}) {
    this.hasFts5 = forceNoFts ? false : this._probeFts5();

    if (!this.hasFts5) {
      this.setMeta('fts5', '0');
      return false;
    }

    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
        name, parts, qname, signature, doc,
        content='',
        contentless_delete=1,
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS fts_map (
        rowid   INTEGER PRIMARY KEY,
        node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_fts_map_node ON fts_map(node_id);
    `);
    this.setMeta('fts5', '1');

    // An index built on a binary without FTS5 has nodes but no FTS rows. On the
    // first open with FTS5 available, backfill rather than silently returning
    // worse results than the machine is capable of.
    const nodes = this.get("SELECT COUNT(*) n FROM nodes WHERE kind != 'module'")?.n ?? 0;
    const indexed = this.get('SELECT COUNT(*) n FROM fts_map')?.n ?? 0;
    if (nodes > 0 && indexed === 0) this._backfillFts();

    return true;
  }

  _probeFts5() {
    try {
      this.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS _cgraph_fts_probe USING fts5(x)');
      this.db.exec('DROP TABLE IF EXISTS _cgraph_fts_probe');
      return true;
    } catch {
      return false;
    }
  }

  _backfillFts() {
    const rows = this.all(
      `SELECT id, name, qname, signature, doc FROM nodes WHERE kind != 'module'`
    );
    this.transaction(() => {
      for (const n of rows) {
        this.indexNodeForSearch(n.id, {
          name: n.name, qname: n.qname, signature: n.signature, doc: n.doc,
        });
      }
    });
  }

  // -- meta / counters -------------------------------------------------------

  getMeta(key) {
    return this.get('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
  }

  setMeta(key, value) {
    this.run(
      `INSERT INTO meta(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      String(value)
    );
  }

  /** Additively bump numeric counters (the savings ledger uses this). */
  bumpCounters(deltas) {
    this.transaction(() => {
      for (const [key, delta] of Object.entries(deltas)) {
        this.run(
          // Both casts are required: node:sqlite binds JS numbers as REAL, so
          // without CAST(? AS INTEGER) the counter drifts to '350.0'.
          `INSERT INTO meta(key, value) VALUES(?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = CAST(CAST(meta.value AS INTEGER) + CAST(? AS INTEGER) AS TEXT)`,
          key,
          String(delta),
          delta
        );
      }
    });
  }

  counters(prefix = '') {
    const rows = prefix
      ? this.all('SELECT key, value FROM meta WHERE key LIKE ?', `${prefix}%`)
      : this.all('SELECT key, value FROM meta');
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  // -- file lifecycle --------------------------------------------------------

  getFileByPath(p) {
    return this.get('SELECT * FROM files WHERE path = ?', p);
  }

  allFiles() {
    return this.all('SELECT * FROM files ORDER BY path');
  }

  upsertFile(f) {
    this.run(
      `INSERT INTO files(path, lang, pack, hash, mtime, size, loc, tok, parsed, skip_reason, indexed_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         lang = excluded.lang, pack = excluded.pack, hash = excluded.hash,
         mtime = excluded.mtime, size = excluded.size, loc = excluded.loc,
         tok = excluded.tok, parsed = excluded.parsed,
         skip_reason = excluded.skip_reason, indexed_at = excluded.indexed_at`,
      f.path, f.lang ?? null, f.pack ?? null, f.hash, f.mtime, f.size,
      f.loc ?? 0, f.tok ?? 0, f.parsed ? 1 : 0, f.skipReason ?? null,
      f.indexedAt ?? Date.now()
    );
    return this.getFileByPath(f.path).id;
  }

  /**
   * Drop everything derived from a file, so it can be re-extracted cleanly.
   * Delete-then-insert is what keeps incremental updates from leaving orphans.
   */
  clearFileData(fileId) {
    // FTS and trigram rows hang off nodes; clear them before the cascade so the
    // contentless FTS index doesn't retain stale entries.
    if (this.hasFts5) {
      this.run(
        `DELETE FROM symbols_fts WHERE rowid IN
           (SELECT rowid FROM fts_map WHERE node_id IN (SELECT id FROM nodes WHERE file_id = ?))`,
        fileId
      );
      this.run(
        'DELETE FROM fts_map WHERE node_id IN (SELECT id FROM nodes WHERE file_id = ?)',
        fileId
      );
    }
    this.run(
      'DELETE FROM trigrams WHERE node_id IN (SELECT id FROM nodes WHERE file_id = ?)',
      fileId
    );
    this.run('DELETE FROM edges WHERE file_id = ?', fileId);
    this.run('DELETE FROM imports WHERE file_id = ?', fileId);
    this.run('DELETE FROM unresolved WHERE file_id = ?', fileId);
    this.run('DELETE FROM refs WHERE file_id = ?', fileId);
    this.run('DELETE FROM nodes WHERE file_id = ?', fileId);

    // Edges *into* this file's nodes are owned by other files and survive the
    // cascade above only by accident of their own file_id. They point at node
    // ids that are about to disappear, so they go too — otherwise a re-indexed
    // file leaves dangling callers that resolve to nothing.
    this.run(
      'DELETE FROM edges WHERE dst_id IN (SELECT id FROM nodes WHERE file_id = ?)',
      fileId
    );
  }

  removeFile(fileId) {
    this.clearFileData(fileId);
    this.run('DELETE FROM files WHERE id = ?', fileId);
  }

  // -- nodes and search indexes ----------------------------------------------

  /**
   * Insert a node and register it in both search indexes.
   *
   * FTS and trigram writes live here rather than in the extractor so that no
   * caller can add a node that is invisible to search — a class of bug that
   * looks like "the graph is fine but find() returns nothing".
   */
  insertNode(n) {
    this.run(
      `INSERT INTO nodes(file_id, parent_id, kind, name, qname, start_line, end_line,
                         start_byte, end_byte, signature, doc, visibility, is_exported, hash, tok)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      n.fileId, n.parentId ?? null, n.kind, n.name, n.qname,
      n.startLine, n.endLine, n.startByte, n.endByte,
      n.signature ?? null, n.doc ?? null, n.visibility ?? null,
      n.isExported ? 1 : 0, n.hash ?? null, n.tok ?? 0
    );
    const id = this.get('SELECT last_insert_rowid() AS id').id;
    this.indexNodeForSearch(id, n);
    return id;
  }

  indexNodeForSearch(nodeId, n) {
    // Trigrams are always available; FTS5 may not be. Ordering matters: the
    // trigram index is what keeps substring search working on a Node built
    // without FTS5.
    const insertTri = this.stmt('INSERT INTO trigrams(tri, node_id) VALUES(?, ?)');
    for (const tri of trigrams(n.name)) insertTri.run(tri, nodeId);

    if (!this.hasFts5) return;

    this.run(
      `INSERT INTO symbols_fts(name, parts, qname, signature, doc) VALUES(?, ?, ?, ?, ?)`,
      n.name, identifierParts(n.name), n.qname, n.signature ?? '', n.doc ?? ''
    );
    const rowid = this.get('SELECT last_insert_rowid() AS id').id;
    this.run('INSERT INTO fts_map(rowid, node_id) VALUES(?, ?)', rowid, nodeId);
  }

  // -- stats -----------------------------------------------------------------

  stats() {
    const one = (sql) => this.get(sql)?.n ?? 0;
    return {
      files: one('SELECT COUNT(*) n FROM files'),
      parsed: one('SELECT COUNT(*) n FROM files WHERE parsed = 1'),
      nodes: one('SELECT COUNT(*) n FROM nodes'),
      edges: one('SELECT COUNT(*) n FROM edges'),
      exact: one("SELECT COUNT(*) n FROM edges WHERE confidence = 'EXACT'"),
      inferred: one("SELECT COUNT(*) n FROM edges WHERE confidence = 'INFERRED'"),
      unresolved: one('SELECT COUNT(*) n FROM unresolved'),
      externals: one('SELECT COUNT(*) n FROM externals'),
      loc: one('SELECT COALESCE(SUM(loc), 0) n FROM files'),
      tok: one('SELECT COALESCE(SUM(tok), 0) n FROM files'),
    };
  }

  close() {
    this._stmts.clear();
    this.db.close();
  }
}
