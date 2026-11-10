/**
 * Reference resolution.
 *
 * Turns queued `refs` rows into `edges`, and everything it cannot prove into
 * `unresolved` diagnostics. This is the hardest part of the tool and the part
 * most likely to be quietly wrong, so the design is built around one rule:
 *
 *   NEVER GUESS SILENTLY.
 *
 * Every edge carries a confidence. EXACT means the target was proven — traced
 * through the import table, or found in the same file's lexical scope. INFERRED
 * means a name matched and nothing contradicted it. An agent that acts on a
 * wrong edge wastes far more tokens than one that was told "this is a guess",
 * and `cgraph doctor` reports the ratio so the quality is visible rather than
 * assumed.
 *
 * Resolution order, most reliable first:
 *   1. receiver matches an imported alias      -> EXACT  (cross-file, proven)
 *   2. name matches an imported alias          -> EXACT  (cross-file, proven)
 *   3. name defined in the same file           -> EXACT  (local scope)
 *   4. name defined in exactly one file        -> INFERRED (unambiguous guess)
 *   5. name defined in several files           -> INFERRED to the best-ranked
 *   6. name is a known dependency symbol       -> external edge
 *   7. otherwise                               -> unresolved, with a reason
 */

import { relFromRoot } from './paths.js';

export const EXACT = 'EXACT';
export const INFERRED = 'INFERRED';

export class Resolver {
  /**
   * @param {object} opts
   * @param {(done: number, total: number) => void} [opts.onProgress] called as
   *   references are resolved. The pass is synchronous and takes seconds on a
   *   large graph, so without this a caller has nothing to show for it.
   */
  constructor({ store, config, registry, onProgress = null }) {
    this.store = store;
    this.config = config;
    this.registry = registry;
    this.onProgress = onProgress;
  }

  /**
   * Resolve every queued reference.
   * @param {object} [opts]
   * @param {number[]} [opts.fileIds] limit to these files (incremental updates)
   */
  run({ fileIds = null } = {}) {
    const stats = { edges: 0, exact: 0, inferred: 0, external: 0, unresolved: 0, byReason: new Map() };

    this.store.transaction(() => {
      // Refs outlive resolution (they are re-resolved whenever the symbol table
      // changes), so derived rows must be cleared first or every re-index
      // doubles the edge count.
      if (fileIds?.length) {
        const holes = fileIds.map(() => '?').join(',');
        this.store.run(`DELETE FROM edges WHERE file_id IN (${holes})`, ...fileIds);
        this.store.run(`DELETE FROM unresolved WHERE file_id IN (${holes})`, ...fileIds);
      } else {
        this.store.run('DELETE FROM edges');
        this.store.run('DELETE FROM unresolved');
        // use_count is recomputed from scratch alongside the edges that feed it.
        this.store.run('UPDATE externals SET use_count = 0');
      }

      this._resolveImports();
      const symbols = this._buildSymbolTable();
      this._resolveRefs(symbols, fileIds, stats);
    });

    return stats;
  }

  /**
   * Link import specifiers to files (or mark them external).
   *
   * Every cross-file EXACT edge depends on this table, so a resolver hook that
   * silently returns null degrades the whole graph to guesswork for that
   * language. `doctor` reports the unresolved-import rate for exactly that
   * reason.
   */
  _resolveImports() {
    const files = new Map(
      this.store.all('SELECT id, path, lang FROM files').map((f) => [f.path, f])
    );
    const rows = this.store.all(
      `SELECT i.id, i.file_id, i.spec, i.symbol, f.path AS from_path, f.lang
         FROM imports i JOIN files f ON f.id = i.file_id
        WHERE i.resolved_file_id IS NULL AND i.external_id IS NULL`
    );

    // Namespace -> declaring file. Built lazily and only once, because most
    // languages never ask for it: C# and similar resolve a `using` to a
    // *namespace*, which is declared across files rather than located at a path.
    let namespaces = null;
    const namespaceIndex = () => {
      if (namespaces) return namespaces;
      namespaces = new Map();
      for (const row of this.store.all(
        `SELECT n.name, f.path FROM nodes n JOIN files f ON f.id = n.file_id
          WHERE n.kind = 'module' AND n.name NOT LIKE '%/%'`
      )) {
        if (!namespaces.has(row.name)) namespaces.set(row.name, row.path);
      }
      return namespaces;
    };

    const ctx = {
      root: this.config.root,
      hasFile: (p) => files.has(p),
      fileFor: (p) => files.get(p) ?? null,
      allPaths: () => files.keys(),

      /** Any indexed path matching a pattern — used for project-type detection. */
      hasAnyMatching: (re) => {
        for (const p of files.keys()) if (re.test(p)) return true;
        return false;
      },

      /**
       * The file declaring a namespace, or null.
       *
       * Falls back to the longest declared prefix: `using A.B.C` in a repo that
       * declares `A.B` should still resolve, since C# namespaces nest.
       */
      findNamespace: (ns) => {
        const index = namespaceIndex();
        if (index.has(ns)) return index.get(ns);
        let best = null;
        for (const [declared, file] of index) {
          if (ns.startsWith(declared + '.') && (!best || declared.length > best.len)) {
            best = { file, len: declared.length };
          }
        }
        return best?.file ?? null;
      },
    };

    const setFile = this.store.stmt('UPDATE imports SET resolved_file_id = ? WHERE id = ?');
    const setExternal = this.store.stmt('UPDATE imports SET external_id = ? WHERE id = ?');

    for (const row of rows) {
      const pack = this.registry?.packFor(row.lang);
      const target = pack?.resolveImport?.(row.spec, row.from_path, ctx) ?? null;

      if (target?.file && files.has(target.file)) {
        setFile.run(files.get(target.file).id, row.id);
        continue;
      }

      if (target?.external) {
        const extId = this._externalId(target.external, row.symbol);
        setExternal.run(extId, row.id);
      }
      // A specifier neither resolvable nor recognisably external is left null.
      // It shows up in doctor's import-resolution rate rather than being
      // silently converted into a wrong edge.
    }
  }

  _externalId({ ecosystem, package: pkg }, symbol) {
    const existing = this.store.get(
      'SELECT id FROM externals WHERE ecosystem = ? AND package = ? AND symbol = ?',
      ecosystem, pkg, symbol ?? ''
    );
    if (existing) return existing.id;

    this.store.run(
      `INSERT INTO externals(ecosystem, package, symbol, source, use_count)
       VALUES(?, ?, ?, 'import', 0)`,
      ecosystem, pkg, symbol ?? ''
    );
    return this.store.get('SELECT last_insert_rowid() AS id').id;
  }

  /**
   * Repo-wide symbol table.
   *
   * Built once per resolve pass and held in memory: a per-reference SQL lookup
   * turns resolution into hundreds of thousands of queries, which dominated
   * index time before this was hoisted.
   */
  _buildSymbolTable() {
    const byName = new Map();     // name -> [{id, fileId, kind, rank, exported}]
    const byFileName = new Map(); // `${fileId}\0${name}` -> id

    const rows = this.store.all(
      `SELECT id, file_id, name, kind, is_exported, rank FROM nodes WHERE kind != 'module'`
    );

    for (const r of rows) {
      let list = byName.get(r.name);
      if (!list) byName.set(r.name, (list = []));
      list.push({ id: r.id, fileId: r.file_id, kind: r.kind, exported: r.is_exported, rank: r.rank });

      const key = `${r.file_id}\0${r.name}`;
      // First definition wins within a file: an overload or re-assignment later
      // in the file should not displace the primary definition.
      if (!byFileName.has(key)) byFileName.set(key, r.id);
    }

    return { byName, byFileName };
  }

  _resolveRefs(symbols, fileIds, stats) {
    const where = fileIds?.length
      ? `WHERE r.file_id IN (${fileIds.map(() => '?').join(',')})`
      : '';
    const params = fileIds?.length ? fileIds : [];

    const refs = this.store.all(
      `SELECT r.id, r.file_id, r.src_id, r.name, r.receiver, r.kind, r.line, f.lang
         FROM refs r JOIN files f ON f.id = r.file_id ${where.replace('r.file_id', 'r.file_id')}`,
      ...params
    );

    // Import bindings per file: alias -> {fileId | externalId, symbol}
    const bindings = this._buildBindings();

    const insertEdge = this.store.stmt(
      `INSERT INTO edges(src_id, dst_id, ext_id, kind, confidence, file_id, line)
       VALUES(?, ?, ?, ?, ?, ?, ?)`
    );
    const insertUnresolved = this.store.stmt(
      `INSERT INTO unresolved(file_id, line, name, kind, reason) VALUES(?, ?, ?, ?, ?)`
    );
    const bumpExternal = this.store.stmt(
      'UPDATE externals SET use_count = use_count + 1 WHERE id = ?'
    );

    let done = 0;
    for (const ref of refs) {
      if (this.onProgress && (done++ & 4095) === 0) this.onProgress(done - 1, refs.length);
      let resolved = this._resolveOne(ref, symbols, bindings);

      // A reference into the language runtime is not a resolution failure.
      // Checked only after project symbols, so a local function named `filter`
      // still wins over the Array method of the same name.
      if (!resolved) {
        const builtin = this._asBuiltin(ref);
        if (builtin) resolved = builtin;
      }

      if (!resolved) {
        insertUnresolved.run(ref.file_id, ref.line, ref.name, ref.kind, 'no-match');
        stats.unresolved++;
        bump(stats.byReason, 'no-match');
        continue;
      }

      if (resolved.externalId) {
        insertEdge.run(ref.src_id, null, resolved.externalId, ref.kind, resolved.confidence, ref.file_id, ref.line);
        bumpExternal.run(resolved.externalId);
        stats.external++;
        stats.edges++;
        continue;
      }

      // A symbol referring to itself (recursion) is real, but a self-edge adds
      // nothing to impact analysis and clutters caller lists.
      if (resolved.nodeId === ref.src_id) continue;

      insertEdge.run(ref.src_id, resolved.nodeId, null, ref.kind, resolved.confidence, ref.file_id, ref.line);
      stats.edges++;
      if (resolved.confidence === EXACT) stats.exact++;
      else stats.inferred++;
    }
  }

  /**
   * Classify a reference as a language built-in, if the pack declares one.
   *
   * Prototype methods require a receiver: a bare `filter()` is far more likely
   * to be a project helper than `Array.prototype.filter`, and misclassifying it
   * would hide a real edge. `x.filter()` is unambiguous enough to accept.
   */
  _asBuiltin(ref) {
    const pack = this.registry?.packFor(ref.lang);
    const builtins = pack?.builtins;
    if (!builtins) return null;

    const isGlobal = builtins.globals?.has(ref.name);
    const isMethod = ref.receiver && builtins.methods?.has(ref.name);
    if (!isGlobal && !isMethod) return null;

    const id = this._externalId(
      { ecosystem: 'builtin', package: builtins.package ?? ref.lang },
      ref.name
    );
    return { externalId: id, confidence: EXACT };
  }

  _buildBindings() {
    const map = new Map(); // fileId -> Map(alias -> binding)
    const rows = this.store.all(
      `SELECT file_id, alias, symbol, resolved_file_id, external_id FROM imports
        WHERE alias IS NOT NULL OR symbol IS NOT NULL`
    );

    for (const r of rows) {
      let m = map.get(r.file_id);
      if (!m) map.set(r.file_id, (m = new Map()));
      const key = r.alias ?? r.symbol;
      if (key) {
        m.set(key, {
          fileId: r.resolved_file_id,
          externalId: r.external_id,
          symbol: r.symbol,
        });
      }
    }
    return map;
  }

  _resolveOne(ref, symbols, bindings) {
    const fileBindings = bindings.get(ref.file_id);

    // 1. Member call through an imported binding: `db.users.find()` where `db`
    //    was imported. The receiver's root segment is the binding name.
    if (ref.receiver && fileBindings) {
      const rootSegment = String(ref.receiver).split(/[.\[]/)[0].trim();
      const binding = fileBindings.get(rootSegment);
      if (binding) {
        if (binding.externalId) {
          return { externalId: binding.externalId, confidence: EXACT };
        }
        if (binding.fileId) {
          const hit = symbols.byFileName.get(`${binding.fileId}\0${ref.name}`);
          // The import is proven even when the member is not found in the target
          // file — the member may be inherited or dynamically attached. Falling
          // back to a repo-wide name match here would be a worse guess than the
          // import already gives us.
          if (hit) return { nodeId: hit, confidence: EXACT };
        }
      }
    }

    // 2. Direct call of an imported name: `login()` where `login` was imported.
    if (fileBindings) {
      const binding = fileBindings.get(ref.name);
      if (binding) {
        if (binding.externalId) return { externalId: binding.externalId, confidence: EXACT };
        if (binding.fileId) {
          const target = binding.symbol ?? ref.name;
          const hit = symbols.byFileName.get(`${binding.fileId}\0${target}`);
          if (hit) return { nodeId: hit, confidence: EXACT };
        }
      }
    }

    // 3. Defined in this same file — lexical scope, no import needed.
    const local = symbols.byFileName.get(`${ref.file_id}\0${ref.name}`);
    if (local) return { nodeId: local, confidence: EXACT };

    // 4/5. Fall back to the repo-wide name index. This is a guess, and it is
    //      labelled as one.
    const candidates = symbols.byName.get(ref.name);
    if (!candidates?.length) return null;

    if (candidates.length === 1) {
      return { nodeId: candidates[0].id, confidence: INFERRED };
    }

    // Several definitions share the name. Prefer exported ones — an unexported
    // symbol in another file cannot be what this reference means.
    const exported = candidates.filter((c) => c.exported);
    const pool = exported.length ? exported : candidates;

    // Prefer a callable when the reference is a call; a class field named
    // `handler` is rarely what `handler()` refers to.
    const kindPreferred = ref.kind === 'call'
      ? pool.filter((c) => c.kind === 'function' || c.kind === 'method')
      : [];
    const finalPool = kindPreferred.length ? kindPreferred : pool;

    // rank is computed from the call graph of the previous resolve pass (this
    // one hasn't run yet), so it is a stale but still meaningful tiebreaker —
    // better than the arbitrary row order SQLite happened to return.
    const best = finalPool.reduce((a, b) => (b.rank > a.rank ? b : a));

    return { nodeId: best.id, confidence: INFERRED, ambiguous: finalPool.length > 1 };
  }
}

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * Shared helper for pack `resolveImport` hooks: try a base path against a list
 * of candidate suffixes and return the first that exists in the index.
 */
export function tryCandidates(ctx, base, suffixes) {
  for (const suffix of suffixes) {
    const candidate = base + suffix;
    if (ctx.hasFile(candidate)) return candidate;
  }
  return null;
}

/** Normalize `a/b/../c` to `a/c` without touching the filesystem. */
export function normalizeRelative(base, spec) {
  const parts = base.split('/');
  parts.pop(); // drop the filename
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

export { relFromRoot };
