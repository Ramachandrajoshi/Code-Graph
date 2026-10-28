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
  // implementations and the caller cannot tell which ran. Both now draw on the
  // SAME sanitized term list (see buildTerms) so the candidate SET they feed
  // into scoring is the same modulo the LIKE/FTS5 token-boundary difference
  // that `trigramMatches` already covers in both paths.
  for (const row of textMatches(store, q)) add(row, 25, 'text');
  for (const row of trigramMatches(store, q)) add(row, 10, 'fuzzy');
  // Files with no symbols (images, binaries, oversized, generated, ...) are
  // invisible to every strategy above, since those all query `nodes`. Without
  // this, `find` reports "no symbols matching" for a file the index knows
  // perfectly well exists — the agent is told to look elsewhere for something
  // that was in front of it. Scored below a real fuzzy symbol match so a file
  // named after a query never buries the code that actually answers it.
  for (const row of fileMatches(store, q)) add(row, 8, 'file');

  const unfiltered = [...scores.values()];
  const filtered = unfiltered.filter(({ node }) => {
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

  // Deterministic ordering (MCP spec: stable order improves prompt-cache hits):
  // SQLite does not guarantee ordering for tied keys, and PageRank/score ties
  // shuffle rows across runs. The `id` tiebreak resolves rows that tie on BOTH
  // final score and qname. It never reorders the primary ranking — it only
  // stabilizes rows the ranking already considers equal.
  filtered.sort(
    (a, b) =>
      b.final - a.final ||
      a.node.qname.localeCompare(b.node.qname) ||
      a.node.id - b.node.id
  );
  const result = filtered.slice(0, limit);

  // TRUNCATE LOUDLY (AGENTS.md): a filter typo, an out-of-enum kind, or a
  // language whose pack never loaded turns a real set of matches into an empty
  // result that reads exactly like "nothing exists here" — the agent stops
  // looking. When a filter is set and it is the filter that emptied a non-empty
  // candidate set, say so and give the count so the caller can question the
  // filter. Purely additive; the result array is unchanged when matches survive.
  if (result.length === 0 && unfiltered.length > 0) {
    const setFilters = [];
    if (kind) setFilters.push('--kind');
    if (lang) setFilters.push('--lang');
    if (path) setFilters.push('--path');
    if (setFilters.length) {
      result.filterNote =
        `${unfiltered.length} symbol${unfiltered.length === 1 ? '' : 's'} matched ` +
        `'${q}'; all excluded by your ${setFilters.join(' / ')} filter — ` +
        `check the filter value (drop it to see them)`;
    }
  }
  return result;
}

/**
 * Closest real symbol names to a query, for the no-match case.
 *
 * WHY this exists: a bare "nothing found" is a dead end, and an agent stops
 * looking at a dead end (AGENTS.md: truncate loudly, degrade gracefully). The
 * Anthropic "Writing Effective Tools" guidance is that a tool error should be
 * self-correctable — the model can retry from it. The correction here is the
 * real symbol the user almost certainly meant.
 *
 * NEVER GUESS SILENTLY: every suggestion is a row from the live `trigrams`
 * join, scored by trigram overlap against the query. Nothing is fabricated. If
 * no real symbol clears `minShare`, the list is empty and the caller says so —
 * inventing a plausible name would send the agent chasing a symbol that does
 * not exist, which is the exact failure mode "never guess" forbids.
 *
 * It is deliberately LOOSER than search(): a lower trigram threshold surfaces
 * the typo'd near-miss ("handlLogin" -> "handleLogin") that search()'s stricter
 * scoring already rejected. Results are deduped by node and ordered on a total
 * key (overlap, rank, id) so the suggestion list is byte-stable across runs.
 *
 * @returns {{name:string,qname:string,path:string,kind:string}[]} at most `limit`,
 *          empty when the index has no symbol above the floor (or is empty).
 */
export function suggestSymbols(store, query, { limit = 5, minShare = 0.5 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 3) return [];

  const tris = trigrams(q);
  if (!tris.length) return [];

  // Surface every node sharing at least one query trigram (threshold 1), then
  // apply the similarity floor in JS so it is a clean share of the query's
  // trigrams. The LIMIT is generous because the floor + cap run afterwards; a
  // tight SQL LIMIT would drop the best matches on a large index.
  const holes = tris.map(() => '?').join(',');
  const rows = store.all(
    `SELECT n.id, n.name, n.qname, n.kind, n.rank, f.path,
            COUNT(DISTINCT t.tri) AS shared
       FROM trigrams t
       JOIN nodes n ON n.id = t.node_id
       JOIN files f ON f.id = n.file_id
      WHERE t.tri IN (${holes}) AND n.kind != 'module'
      GROUP BY n.id
       ORDER BY shared DESC, n.rank DESC, n.id
       LIMIT 80`,
    ...tris
  );

  const floor = tris.length * minShare;
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (r.shared < floor) break; // rows are ordered by shared DESC
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ name: r.name, qname: r.qname, path: r.path, kind: r.kind });
    if (out.length >= limit) break;
  }
  return out;
}

/** True when the index has no symbols at all (unbuilt/empty), so callers say so. */
export function indexIsEmpty(store) {
  const row = store.get('SELECT COUNT(*) AS c FROM nodes');
  return !row || row.c === 0;
}

/**
 * Compact, actionable text for a no-match result — shared by `find` and
 * `map`(symbol) on both the CLI and MCP paths so the two never drift.
 *
 * Mirrors search()'s `filterNote` guidance for the DISTINCT no-filter case:
 * name the closest REAL symbols (suggestSymbols), and remind about staleness.
 * Never fabricates — if nothing clears the similarity floor it says "no close
 * matches". Kept terse: these lines are paid for in tokens on every miss.
 */
export function formatSuggestions(store, query) {
  if (indexIsEmpty(store)) {
    return `No index found — run \`cgraph init\` (or \`cgraph update\`) to build one before searching.`;
  }
  const sugs = suggestSymbols(store, query, { limit: 5 });
  const lines = [
    // Lead-in keeps the pre-existing "No symbols matching '<q>'" phrasing so
    // existing consumers (and the freshness tests) keep matching.
    `No symbols matching '${query}'.`,
    sugs.length
      ? `Did you mean: ${sugs.map((s) => s.name).join(', ')}?`
      : 'No close matches in the index.',
    'The symbol may be defined dynamically, live in a language with no extraction ' +
      'queries yet, or the index may be stale — run `cgraph update` to check.',
  ];
  return lines.join('\n');
}

/**
 * The shared, sanitized term list used by BOTH text paths.
 *
 * FTS5 treats `-`, `*`, `"`, `:` and friends as operators, so a raw query
 * ("get-user", "foo:bar") is a syntax error there; the FTS5 path strips
 * non-alphanumerics. The LIKE path historically kept the RAW query as a
 * contiguous substring term (`%get-user%`) *in addition to* the split words —
 * so the two paths fed the scorer different terms and the caller could not tell
 * which ran. This single builder makes both consume the SAME terms.
 *
 * WHY dropping the raw-with-operators term is set-neutral for LIKE: any string
 * that contains the contiguous substring "get-user" necessarily contains
 * "get" and "user", so the sanitized fragments already subsume it; keeping it
 * added divergence (ordering, and substring matches FTS5 can never produce) for
 * no extra hits. The residual LIKE-vs-FTS5 gap is substring-contains vs
 * token-prefix; that is inherent to a LIKE scan and is covered in BOTH paths by
 * `trigramMatches`, so the goal here is parity of the candidate SET, not
 * identical ranking — the scorer re-ranks by `rank`, so bm25-vs-LIKE ordering
 * is not load-bearing.
 */
function buildTerms(q) {
  return [...new Set([...q.split(/\s+/), ...splitIdentifier(q)])]
    .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((t) => t.length >= 2);
}

function baseSelect(extra) {
  return `SELECT n.id, n.name, n.qname, n.kind, n.signature, n.doc, n.start_line,
                 n.end_line, n.rank, n.is_exported, f.path, f.lang, f.subproject
            FROM nodes n JOIN files f ON f.id = n.file_id
           ${extra}`;
}

function exactMatches(store, q) {
  // `n.id` is the deterministic tiebreak (MCP spec: stable ordering improves
  // prompt-cache hits). At the LIMIT boundary SQLite may drop a different tied
  // row each run, changing the candidate SET that reaches scoring; a total order
  // on (rank, id) makes the surviving set byte-stable.
  return store.all(
    baseSelect(`WHERE n.name = ? AND n.kind != 'module' ORDER BY n.rank DESC, n.id LIMIT 50`),
    q
  );
}

function prefixMatches(store, q) {
  if (q.length < 2) return [];
  return store.all(
    baseSelect(`WHERE n.name LIKE ? AND n.name != ? AND n.kind != 'module'
                ORDER BY n.rank DESC, n.id LIMIT 50`),
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
  // Same sanitized terms as the FTS5 path (see buildTerms): the prior LIKE path
  // also searched the RAW query with its operator chars as a `%...%` substring,
  // which FTS5 could never match — the source of the path divergence.
  const terms = buildTerms(q);

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
            n.end_line, n.rank, n.is_exported, f.path, f.lang, f.subproject
       FROM nodes n JOIN files f ON f.id = n.file_id
      WHERE n.kind != 'module' AND (${clauses.join(' OR ')})
      ORDER BY n.rank DESC, n.id
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
  const terms = buildTerms(q);

  if (!terms.length) return [];

  // OR rather than AND: a partial match on a multi-word query is still useful,
  // and the scoring above rewards symbols that matched more of it.
  const expr = terms.map((t) => `"${t}"*`).join(' OR ');

  try {
    return store.all(
      `SELECT n.id, n.name, n.qname, n.kind, n.signature, n.doc, n.start_line,
              n.end_line, n.rank, n.is_exported, f.path, f.lang, f.subproject
         FROM symbols_fts s
         JOIN fts_map m ON m.rowid = s.rowid
         JOIN nodes n ON n.id = m.node_id
         JOIN files f ON f.id = n.file_id
        WHERE symbols_fts MATCH ? AND n.kind != 'module'
        ORDER BY bm25(symbols_fts), n.id LIMIT 60`,
      expr
    );
  } catch {
    // A malformed FTS expression must degrade to "no text hits", never take
    // down the whole search.
    return [];
  }
}

/**
 * Path/name matches against files that carry no symbols at all.
 *
 * Deliberately scoped to `parsed = 0`: a file with symbols is already
 * reachable through the strategies above, and matching its path too would
 * mean every hit on a popular file name doubles up with a near-identical
 * file-level row.
 */
function fileMatches(store, q) {
  if (q.length < 2) return [];
  const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const rows = store.all(
    `SELECT id, path, lang, skip_reason, subproject FROM files
      WHERE parsed = 0 AND path LIKE ? ESCAPE '\\'
      ORDER BY path LIMIT 30`,
    like
  );
  return rows.map((f) => ({
    // Prefixed so this can never collide with a node id in the same score map.
    id: `file:${f.id}`,
    name: f.path.split('/').pop(),
    qname: f.path,
    kind: 'file',
    signature: null,
    doc: null,
    start_line: null,
    end_line: null,
    rank: 0,
    is_exported: 0,
    path: f.path,
    lang: f.lang,
    subproject: f.subproject,
    skipReason: f.skip_reason,
  }));
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
            n.end_line, n.rank, n.is_exported, f.path, f.lang, f.subproject
       FROM trigrams t
       JOIN nodes n ON n.id = t.node_id
       JOIN files f ON f.id = n.file_id
      WHERE t.tri IN (${holes}) AND n.kind != 'module'
      GROUP BY n.id
     HAVING COUNT(DISTINCT t.tri) >= ?
      ORDER BY COUNT(DISTINCT t.tri) DESC, n.rank DESC, n.id
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
  // `search()` attaches a filterNote when a filter emptied an otherwise
  // non-empty result. Rendering it here means every consumer (CLI find, MCP
  // find) shows the guidance for free, and a silent-empty truncation is
  // impossible.
  if (hits.filterNote) lines.push(hits.filterNote);
  let i = 1;
  for (const hit of hits) {
    const n = hit.node;
    const star = n.rank >= 0.5 ? '*' : ' ';
    const why = showWhy ? `  [${hit.why.join('+')}]` : '';

    if (n.kind === 'file') {
      const reason = n.skipReason ? `  (${n.skipReason})` : '';
      lines.push(`${String(i++).padStart(2)}${star} ${n.path}  file${reason}${why}`);
      continue;
    }

    lines.push(
      `${String(i++).padStart(2)}${star} ${n.qname}  ${n.path}:${n.start_line}  ${n.kind}${why}`
    );
    if (n.signature && n.signature !== n.name) lines.push(`     ${n.signature}`);
  }
  return lines;
}
