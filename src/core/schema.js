/**
 * Database schema and migrations.
 *
 * Migrations are an ordered, append-only list. Each runs once and is recorded in
 * the meta table. Never edit an existing migration — add a new one — because
 * users will have databases at the old version.
 *
 * NOTE: the SQL below lives in a template literal, so it must contain no
 * backticks. A backtick in a SQL comment silently terminates the string and
 * produces a confusing syntax error far from its cause. `test/schema.test.js`
 * enforces this.
 *
 * A migration may set `forceReindex: true` when it adds a column that can
 * only be populated by re-walking the repo (not by the ALTER TABLE itself).
 * `Store.migrate()` surfaces this as `store.needsFullReindex`, which
 * `Indexer.run()` uses to force one full pass so the new column gets backfilled
 * instead of staying null forever on files the incremental fast path never
 * touches again.
 */

export const SCHEMA_VERSION = 3;

export const MIGRATIONS = [
  {
    version: 1,
    name: 'initial',
    up: `
--------------------------------------------------------------------------------
-- Files
--------------------------------------------------------------------------------
CREATE TABLE files (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,   -- repo-relative, POSIX separators, always
  lang        TEXT,                   -- language id, null when undetected
  pack        TEXT,                   -- language pack that handled it
  hash        TEXT NOT NULL,          -- content hash; drives incremental updates
  mtime       INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  loc         INTEGER NOT NULL DEFAULT 0,
  tok         INTEGER NOT NULL DEFAULT 0,  -- token cost of reading it whole
  parsed      INTEGER NOT NULL DEFAULT 0,  -- 0 = stub (too big/binary/no pack)
  skip_reason TEXT,
  indexed_at  INTEGER NOT NULL
);
CREATE INDEX idx_files_lang ON files(lang);
CREATE INDEX idx_files_hash ON files(hash);

--------------------------------------------------------------------------------
-- Nodes: the hierarchy. parent_id chains file -> class -> method -> block, which
-- is what lets an agent drill in progressively instead of reading everything.
--------------------------------------------------------------------------------
CREATE TABLE nodes (
  id          INTEGER PRIMARY KEY,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,          -- module|class|interface|function|method|field|var|const|type|block
  name        TEXT NOT NULL,
  qname       TEXT NOT NULL,          -- 'src/auth/login.ts::LoginService#login'
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  start_byte  INTEGER NOT NULL,
  end_byte    INTEGER NOT NULL,
  signature   TEXT,
  doc         TEXT,
  visibility  TEXT,                   -- public|private|protected|internal
  is_exported INTEGER NOT NULL DEFAULT 0,
  hash        TEXT,                   -- body hash, for "did this symbol change"
  tok         INTEGER NOT NULL DEFAULT 0,
  rank        REAL NOT NULL DEFAULT 0
);
CREATE INDEX idx_nodes_file   ON nodes(file_id);
CREATE INDEX idx_nodes_parent ON nodes(parent_id);
CREATE INDEX idx_nodes_name   ON nodes(name);
CREATE INDEX idx_nodes_qname  ON nodes(qname);
CREATE INDEX idx_nodes_kind   ON nodes(kind);
CREATE INDEX idx_nodes_rank   ON nodes(rank DESC);

--------------------------------------------------------------------------------
-- Edges. confidence is first-class: an agent must be able to tell a proven
-- relationship from a name-match guess, because acting on a wrong edge is worse
-- than having no edge at all.
--------------------------------------------------------------------------------
CREATE TABLE edges (
  id         INTEGER PRIMARY KEY,
  src_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  dst_id     INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
  ext_id     INTEGER REFERENCES externals(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,           -- calls|imports|extends|implements|instantiates|reads|writes|decorates|tests
  confidence TEXT NOT NULL,           -- EXACT | INFERRED
  file_id    INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line       INTEGER NOT NULL
);
CREATE INDEX idx_edges_src  ON edges(src_id, kind);
CREATE INDEX idx_edges_dst  ON edges(dst_id, kind);
CREATE INDEX idx_edges_ext  ON edges(ext_id);
CREATE INDEX idx_edges_file ON edges(file_id);

--------------------------------------------------------------------------------
-- Imports: the resolution backbone. Cross-file edges are only EXACT when they
-- can be traced through this table.
--------------------------------------------------------------------------------
CREATE TABLE imports (
  id               INTEGER PRIMARY KEY,
  file_id          INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  spec             TEXT NOT NULL,     -- raw specifier: './db', 'express', 'os.path'
  symbol           TEXT,              -- named import, null for namespace/default
  alias            TEXT,              -- local binding name
  line             INTEGER NOT NULL,
  resolved_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  external_id      INTEGER REFERENCES externals(id) ON DELETE SET NULL
);
CREATE INDEX idx_imports_file     ON imports(file_id);
CREATE INDEX idx_imports_resolved ON imports(resolved_file_id);
CREATE INDEX idx_imports_alias    ON imports(file_id, alias);

--------------------------------------------------------------------------------
-- Externals: dependency API surface. use_count ranks packages/symbols by how
-- much this project actually calls them (see map/graph external edges).
--------------------------------------------------------------------------------
CREATE TABLE externals (
  id        INTEGER PRIMARY KEY,
  ecosystem TEXT NOT NULL,            -- npm|pypi|go|cargo|maven
  package   TEXT NOT NULL,
  version   TEXT,
  symbol    TEXT NOT NULL,            -- '' for the package itself
  kind      TEXT,
  signature TEXT,
  doc       TEXT,
  source    TEXT,                     -- local|registry
  use_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(ecosystem, package, symbol)
);
CREATE INDEX idx_externals_pkg ON externals(package);
CREATE INDEX idx_externals_use ON externals(use_count DESC);

--------------------------------------------------------------------------------
-- Unresolved references. Kept rather than dropped so "cgraph doctor" can report
-- resolution quality per language, making regressions visible.
--------------------------------------------------------------------------------
CREATE TABLE unresolved (
  id      INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  line    INTEGER NOT NULL,
  name    TEXT NOT NULL,
  kind    TEXT,
  reason  TEXT
);
CREATE INDEX idx_unresolved_file ON unresolved(file_id);

--------------------------------------------------------------------------------
-- Search indexes
--------------------------------------------------------------------------------
-- NOTE: the FTS5 tables (symbols_fts, fts_map) are deliberately NOT created
-- here. FTS5 is a compile-time option in SQLite, and Node's bundled build does
-- not consistently include it — Node 22.14 and 23.11 ship without it while some
-- 24.x builds have it. Availability therefore depends on the specific binary,
-- not on the version, so it cannot be guaranteed by an engines range.
--
-- Store.ensureSearchIndex() probes for FTS5 at open time and creates those
-- tables only when the running binary supports it. Putting them in a migration
-- makes the migration fail outright with "no such module: fts5", which takes
-- the entire tool down on an otherwise perfectly capable Node.

-- Identifier trigrams, for substring matches FTS5 word tokenization can't do
-- (finding 'ogin' inside 'handleLogin').
CREATE TABLE trigrams (
  tri     TEXT NOT NULL,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX idx_trigrams ON trigrams(tri, node_id);

--------------------------------------------------------------------------------
-- Optional embedding storage; populated only when embeddings are configured.
--------------------------------------------------------------------------------
CREATE TABLE chunks (
  node_id INTEGER PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  dim     INTEGER NOT NULL,
  vector  BLOB NOT NULL
);

--------------------------------------------------------------------------------
-- Key/value: schema version, index stats, usage counters.
-- IF NOT EXISTS because migrate() must bootstrap this table before it can read
-- the schema version that decides which migrations to run.
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },

  {
    version: 2,
    name: 'pending-refs',
    up: `
--------------------------------------------------------------------------------
-- Extracted references, held between the parse pass and the resolve pass.
--
-- Resolution needs the whole repo's symbol table, so it cannot run while files
-- are still being parsed one at a time. These rows are the work queue: parse
-- writes them, resolve consumes them and turns each into an edge (or into an
-- unresolved diagnostic).
--
-- The receiver is stored because it is most of what makes a reference
-- resolvable: 'find' is ambiguous across a whole repo, 'db.users.find' is not.
--------------------------------------------------------------------------------
CREATE TABLE refs (
  id       INTEGER PRIMARY KEY,
  file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  src_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  receiver TEXT,
  kind     TEXT NOT NULL,
  line     INTEGER NOT NULL
);
CREATE INDEX idx_refs_file ON refs(file_id);
CREATE INDEX idx_refs_name ON refs(name);

-- Resolution looks up every file that imports a given specifier, so the reverse
-- lookup has to be cheap.
CREATE INDEX idx_imports_spec ON imports(spec);
`,
  },

  {
    version: 3,
    name: 'subprojects',
    // Backfilling existing rows requires re-walking the repo (to find nested
    // .git boundaries), which a migration cannot do — it only shapes the
    // schema. See the forceReindex note above.
    forceReindex: true,
    up: `
--------------------------------------------------------------------------------
-- Sub-project labeling: which nested repo (if any) a file belongs to, for a
-- root that contains a fleet of independently-cloned repos (e.g. a
-- frontend/backend/desktop split, each its own git checkout).
--------------------------------------------------------------------------------
ALTER TABLE files ADD COLUMN subproject TEXT;
CREATE INDEX idx_files_subproject ON files(subproject);
`,
  },
];
