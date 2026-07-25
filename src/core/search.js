/**
 * Symbol search.
 *
 * Replaces grep. The difference is not just ranking: grep returns line hits with
 * no idea what a line *is*, so an agent must read surrounding files to find out
 * whether a hit is a definition, a call, or a comment. Here every hit is a
 * known symbol with a known kind, location and importance.
 *
 * Three retrieval strategies are merged, because each fails where the others
 * work:
 *   - FTS5 over names, split identifier words, signatures and docs
 *   - trigram substring match (finds 'ogin' inside 'handleLogin')
 *   - exact and prefix name match (fast path for the common case)
 *
 * Results are scored by match quality times symbol importance (PageRank), so
 * the answer to "where is auth handled" is the auth entry point rather than an
 * arbitrary test helper.
 */

import { splitIdentifier, trigrams } from './identifiers.js';

/**
 * @param {object} store
 * @param {string} query
 * @param {object} [opts]
 * @param {string} [opts.kind]   filter to a node kind
 * @param {string} [opts.lang]   filter to a language
 * @param {string} [opts.path]   filter to a path prefix
 * @param {number} [opts.limit]
 */
export function search(store, query, opts = {}) {
  const { kind = null, lang = null, path = null, limit = 20 } = opts;
  const q = query.trim();
  if (!q) return [];

  const scores = new Map(); // nodeId -> {node, score, why}

  const add = (row, score, why) => {
    const prior = scores.get(row.id);
    if (prior) {
      // A symbol found by several strategies is a better match than one found
      // by one, so evidence accumulates rather than overwriting.
      prior.score += score;
      if (!prior.why.includes(why)) prior.why.push(why);
      return;
    }
    scores.set(row.id, { node: row, score, why: [why] });
  };

  for (const row of exactMatches(store, q)) add(row, 100, 'exact');
  for (const row of prefixMatches(store, q)) add(row, 40, 'prefix');
  // FTS5 is unavailable in many Node builds, so the text strategy has two
  // implementations and the caller cannot tell which ran.
  for (const row of textMatches(store, q)) add(row, 25, 'text');
  for (const row of trigramMatches(store, q)) add(row, 10, 'fuzzy');

  const filtered = [...scores.values()].filter(({ node }) => {
    if (kind && node.kind !== kind) return false;
    if (lang && node.lang !== lang) return false;
    if (path && !node.path.startsWith(path)) return false;
    return true;
  });

  for (const hit of filtered) {
    // Importance is a multiplier, not an additive term: it should reorder
    // symbols that matched equally well, never promote a weak match over a
    // strong one.
    hit.final = hit.score * (1 + hit.node.rank * 2);
  }

  filtered.sort((a, b) => b.final - a.final || a.node.qname.localeCompare(b.node.qname));
  return filtered.slice(0, limit);
}

function baseSelect(extra) {
  return `SELECT n.id, n.name, n.qname, n.kind, n.signature, n.doc, n.start_line,
                 n.end_line, n.rank, n.is_exported, f.path, f.lang
            FROM nodes n JOIN files f ON f.id = n.file_id
           ${extra}`;
}

function exactMatches(store, q) {
  return store.all(
    baseSelect(`WHERE n.name = ? AND n.kind != 'module' ORDER BY n.rank DESC LIMIT 50`),
    q
  );
}

function prefixMatches(store, q) {
  if (q.length < 2) return [];
  return store.all(
    baseSelect(`WHERE n.name LIKE ? AND n.name != ? AND n.kind != 'module'
                ORDER BY n.rank DESC LIMIT 50`),
    `${q}%`, q
  );
}

/**
 * Text search across names, split identifier words, signatures and docs.
 *
 * Uses FTS5 when the running Node binary has it, and a LIKE scan when it does
 * not. Node's bundled SQLite omits FTS5 in many builds, so this is a routine
 * runtime condition rather than an edge case, and doc/signature search has to
 * keep working either way.
 */
function textMatches(store, q) {
  return store.hasFts5 ? ftsMatches(store, q) : likeMatches(store, q);
}

/**
 * Fallback for builds without FTS5.
 *
 * Scans `nodes` directly. Slower than an inverted index and without relevance
 * ranking, but correct — and the surrounding scorer supplies ordering. Split
 * identifier words are matched too, so "login" still finds "handleLogin",
 * which is the behaviour users would most notice losing.
 */
function likeMatches(store, q) {
  const terms = [...new Set([...q.split(/\s+/), ...splitIdentifier(q)])]
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  if (!terms.length) return [];

  // One OR group per term across name, qname, signature and doc.
  const clauses = [];
  const params = [];
  for (const term of terms) {
    const like = `%${term.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    clauses.push(`(n.name LIKE ? ESCAPE '\\' OR n.qname LIKE ? ESCAPE '\\'
                   OR n.signature LIKE ? ESCAPE '\\' OR n.doc LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like);
  }

  return store.all(
    `SELECT n.id, n.name, n.qname, n.kind, n.signature, n.doc, n.start_line,
            n.end_line, n.rank, n.is_exported, f.path, f.lang
       FROM nodes n JOIN files f ON f.id = n.file_id
      WHERE n.kind != 'module' AND (${clauses.join(' OR ')})
      ORDER BY n.rank DESC
      LIMIT 60`,
    ...params
  );
}

/**
 * Full-text search across names, split identifier words, signatures and docs.
 *
 * The query is sanitized rather than passed through: FTS5 treats characters
 * like `-`, `*`, `"` and `:` as operators, so an unescaped user query
 * ("get-user" or "foo:bar") is a syntax error rather than a search.
 */
function ftsMatches(store, q) {
  const terms = [...new Set([...q.split(/\s+/), ...splitIdentifier(q)])]
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((t) => t.length >= 2);

  if (!terms.length) return [];

  // OR rather than AND: a partial match on a multi-word query is still useful,
  // and the scoring above rewards symbols that matched more of it.
  const expr = terms.map((t) => `"${t}"*`).join(' OR ');

  try {
    return store.all(
      `SELECT n.id, n.name, n.qname, n.kind, n.signature, n.doc, n.start_line,
              n.end_line, n.rank, n.is_exported, f.path, f.lang
         FROM symbols_fts s
         JOIN fts_map m ON m.rowid = s.rowid
         JOIN nodes n ON n.id = m.node_id
         JOIN files f ON f.id = n.file_id
        WHERE symbols_fts MATCH ? AND n.kind != 'module'
        ORDER BY bm25(symbols_fts) LIMIT 60`,
      expr
    );
  } catch {
    // A malformed FTS expression must degrade to "no text hits", never take
    // down the whole search.
    return [];
  }
}

/** Substring matches via trigram overlap — the fallback FTS cannot provide. */
function trigramMatches(store, q) {
  const tris = trigrams(q.toLowerCase());
  if (!tris.length) return [];

  const holes = tris.map(() => '?').join(',');
  // Require most trigrams to match, or every short query matches everything.
  const threshold = Math.max(1, Math.ceil(tris.length * 0.7));

  return store.all(
    `SELECT n.id, n.name, n.qname, n.kind, n.signature, n.doc, n.start_line,
            n.end_line, n.rank, n.is_exported, f.path, f.lang
       FROM trigrams t
       JOIN nodes n ON n.id = t.node_id
       JOIN files f ON f.id = n.file_id
      WHERE t.tri IN (${holes}) AND n.kind != 'module'
      GROUP BY n.id
     HAVING COUNT(DISTINCT t.tri) >= ?
      ORDER BY COUNT(DISTINCT t.tri) DESC, n.rank DESC
      LIMIT 40`,
    ...tris, threshold
  );
}

/**
 * Render search hits as compact lines.
 *
 * One line per hit, ~12 tokens each: rank marker, qualified name, location,
 * kind. Enough for the agent to choose what to read next, and nothing more.
 */
export function renderHits(hits, { showWhy = false } = {}) {
  const lines = [];
  let i = 1;
  for (const hit of hits) {
    const n = hit.node;
    const star = n.rank >= 0.5 ? '*' : ' ';
    const why = showWhy ? `  [${hit.why.join('+')}]` : '';
    lines.push(
      `${String(i++).padStart(2)}${star} ${n.qname}  ${n.path}:${n.start_line}  ${n.kind}${why}`
    );
    if (n.signature && n.signature !== n.name) lines.push(`     ${n.signature}`);
  }
  return lines;
}
