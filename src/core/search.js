/**
 * Symbol search.
 *
 * Replaces grep. The difference is not just ranking: grep returns line hits with
 * no idea what a line *is*, so an agent must read surrounding files to find out
 * whether a hit is a definition, a call, or a comment. Here every hit is a
 * known symbol with a known kind, location and importance.
 *
 * A search runs in two stages.
 *
 *   1. Candidates. Several cheap, overlapping strategies each propose symbols,
 *      because each fails where the others work: an exact name lookup, the
 *      full-text index (names, split identifier words, signatures, docs, and
 *      the words used inside function bodies), trigram substring matching for
 *      fragments and typos, and file paths for files that have no symbols.
 *
 *   2. Scoring. Every candidate is scored against the query the same way, no
 *      matter which strategy proposed it. Each query word is credited once, for
 *      the most telling place it appears — the name beats the signature, the
 *      signature beats the body — weighted by how rare the word is in this
 *      repository. The total is then scaled by how much of the query was
 *      matched at all.
 *
 * That last step is what makes a descriptive query work. "retry failed upload"
 * should find the one function about all three, not the sixty symbols with
 * "upload" in their name; scoring strategies separately and adding the results
 * up, as this file used to, could not tell those apart.
 *
 * The answer is also cut where it stops being useful. Past the point where
 * scores fall well below the best hit, more lines are more tokens for the
 * agent to read and no more likely to contain what it asked for — so they are
 * left out and counted, never silently.
 */

import { splitIdentifier, trigrams, stem } from './identifiers.js';

/**
 * Where a query word was found, most telling first. The gaps are deliberate:
 * a word in the name must outweigh the same word in two weaker places.
 */
const FIELD = {
  nameExact: 12,   // the whole name
  namePart: 9,     // one component word of the name
  nameStem: 7,     // a component word starting with the query word
  nameSub: 5,      // somewhere inside the name
  container: 3,    // enclosing class, or the file path
  signature: 2.5,
  doc: 2.5,
  body: 1.2,       // used inside the function
};

/** bm25 column weights, in the order the FTS table declares its columns. */
const BM25 = 'bm25(symbols_fts, 10.0, 6.0, 2.0, 3.0, 3.0, 1.0)';

/**
 * How far importance (PageRank, 0..1) can lift a score. Enough to order the
 * symbols that matched equally well; not enough for a heavily-called utility
 * to outrank a better textual match, which a larger factor did.
 */
const RANK_WEIGHT = 0.6;

/**
 * A hit scoring below this share of the best one is left out by default.
 *
 * Two values, because the two kinds of query fail differently. A specific
 * query — several words, or a name that matched exactly — has a clear best
 * answer, and what trails far behind it is noise the agent would pay to read.
 * A single vague word ("login") has no best answer, only a list of things it
 * might mean, so more of that list is kept. Measured on two repositories, the
 * tighter cut costs no recall on specific queries and saves a quarter to a
 * third of the response.
 */
const FLOOR_SPECIFIC = 0.45;
const FLOOR_VAGUE = 0.3;

/** Words that carry no search intent in a multi-word query. */
const STOP = new Set((
  'the a an of to in for and or is are be this that these those with from by on at as it ' +
  'its how what where which who why when does do did we i you can will should all any ' +
  'there here get gets into'
).split(' '));

/** Parent kinds that make a field a local object-literal key, not a member. */
const LOCAL_FIELD = new Set(['function', 'method', 'field']);

/** Paths whose symbols are examples of use rather than the thing itself. */
const SECONDARY_PATH = /(^|\/)(tests?|__tests__|specs?|__mocks__|mocks?|fixtures?|examples?|samples?|bench(marks?)?)\/|[._-](test|spec)\.[^/]+$|_test\.[^/]+$/i;

/**
 * @param {object} store
 * @param {string} query
 * @param {object} [opts]
 * @param {string} [opts.kind]   filter to a node kind
 * @param {string} [opts.lang]   filter to a language
 * @param {string} [opts.path]   filter to a path prefix
 * @param {number} [opts.limit]  most hits to return. When the caller does not
 *   pass one, weak matches are also cut (see FLOOR_SPECIFIC) and counted in
 *   `result.weaker`; an explicit limit is honoured in full.
 */
export function search(store, query, opts = {}) {
  const { kind = null, lang = null, path = null } = opts;
  const explicitLimit = opts.limit !== undefined && opts.limit !== null;
  const limit = explicitLimit ? opts.limit : 12;

  const q = String(query ?? '').trim();
  if (!q) return [];

  const plan = analyze(store, q);
  const candidates = new Map(); // id -> { node, why: [] }
  const propose = (rows, why) => {
    for (const row of rows) {
      const prior = candidates.get(row.id);
      if (prior) {
        if (!prior.why.includes(why)) prior.why.push(why);
      } else {
        candidates.set(row.id, { node: row, why: [why] });
      }
    }
  };

  propose(exactMatches(store, plan), 'exact');
  if (store.hasFts5) {
    propose(ftsMatches(store, plan, 'AND'), 'text');
    if (plan.terms.length > 1) propose(ftsMatches(store, plan, 'OR'), 'text');
  } else {
    // FTS5 is a compile-time option many Node builds lack, so this is a
    // routine condition: names, signatures and docs stay searchable by LIKE.
    // Function bodies are not — they exist only in the full-text index.
    propose(prefixMatches(store, plan), 'prefix');
    propose(likeMatches(store, plan), 'text');
  }
  propose(trigramMatches(store, plan), 'fuzzy');

  // Which candidates use each query word inside their body. Asked once per
  // word for all candidates together, rather than once per candidate.
  const bodyHits = bodyMatches(store, plan, candidates);
  const users = identifierUsers(store, plan);
  propose(users.rows, 'uses');

  const scored = [];
  for (const cand of candidates.values()) {
    let score = scoreNode(cand.node, plan, bodyHits);
    // The body uses this exact identifier. That is a far stronger signal than
    // its component words turning up separately, and it is the whole answer
    // to "where is X used" for a name the index has no definition of.
    if (users.ids.has(cand.node.id)) score = Math.max(score, FIELD.body) * 2;
    if (score <= 0) continue;
    cand.score = score;
    scored.push(cand);
  }

  // Files with no symbols (images, binaries, oversized, generated, ...) are
  // invisible to every strategy above, since those all query `nodes`. Without
  // this, `find` reports "no symbols matching" for a file the index knows
  // perfectly well exists — the agent is told to look elsewhere for something
  // that was in front of it. Scored below any symbol whose name matched, so a
  // file named after a query never buries the code that actually answers it.
  for (const row of fileMatches(store, q)) {
    scored.push({ node: row, why: ['file'], score: FIELD.container });
  }

  const filtered = scored.filter(({ node }) => {
    if (kind && node.kind !== kind) return false;
    if (lang && node.lang !== lang) return false;
    if (path && !node.path.startsWith(path)) return false;
    return true;
  });

  for (const hit of filtered) {
    // Importance is a multiplier, not an additive term: it should reorder
    // symbols that matched equally well, never promote a weak match over a
    // strong one.
    hit.final = hit.score * (1 + hit.node.rank * RANK_WEIGHT);
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
      String(a.node.id).localeCompare(String(b.node.id), undefined, { numeric: true })
  );

  let kept = filtered;
  if (!explicitLimit && filtered.length) {
    const best = filtered[0];
    const specific = !plan.single || (best.node.name ?? '').toLowerCase() === plan.lower ||
      (plan.leaf && best.node.name === plan.leaf);
    const floor = best.final * (specific ? FLOOR_SPECIFIC : FLOOR_VAGUE);
    kept = filtered.filter((h) => h.final >= floor);
  }
  const result = kept.slice(0, limit);

  // TRUNCATE LOUDLY (AGENTS.md). Matches that were found but not returned are
  // counted, so a short answer is never mistaken for "that is everything".
  result.weaker = filtered.length - result.length;
  // Whether the cut fell among matches as good as the ones shown (the limit
  // ran out) or below them (the floor). The two call for different next
  // steps — narrow the query, or nothing at all — so they are not reported
  // with the same words.
  result.cutByLimit = kept.length > result.length;

  // A filter typo, an out-of-enum kind, or a language whose pack never loaded
  // turns a real set of matches into an empty result that reads exactly like
  // "nothing exists here" — the agent stops looking. When a filter is set and
  // it is the filter that emptied a non-empty candidate set, say so and give
  // the count so the caller can question the filter.
  if (result.length === 0 && scored.length > 0) {
    const setFilters = [];
    if (kind) setFilters.push('--kind');
    if (lang) setFilters.push('--lang');
    if (path) setFilters.push('--path');
    if (setFilters.length) {
      result.filterNote =
        `${scored.length} symbol${scored.length === 1 ? '' : 's'} matched ` +
        `'${q}'; all excluded by your ${setFilters.join(' / ')} filter — ` +
        `check the filter value (drop it to see them)`;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// query analysis
// ---------------------------------------------------------------------------

/**
 * Break a query into the words it will be scored on.
 *
 * `handleLogin` and `handle login` are the same question, so identifiers are
 * split the way they are at index time. In a multi-word query, filler words
 * are dropped — "where is the config parsed" is a search for config + parsed —
 * unless that would leave nothing.
 */
function analyze(store, q) {
  const single = !/\s/.test(q);

  let words = [...new Set(
    q.split(/\s+/)
      .flatMap((w) => splitIdentifier(w))
      .filter((w) => w.length >= 2)
  )];
  if (words.length > 2) {
    const meaningful = words.filter((w) => !STOP.has(w));
    if (meaningful.length) words = meaningful;
  }
  words = words.slice(0, 10);

  const total = store.hasFts5 ? store.ftsSize() : 0;
  const terms = words.map((raw) => {
    const st = stem(raw);
    return { raw, stem: st, idf: inverseFrequency(store, st, total) };
  });

  // `Class#method`, `ns.fn`, `path/to/file.js::fn`: the last segment is the
  // name being asked for and the rest says which one.
  const segments = single ? q.split(/::|[#./\\]/).filter(Boolean) : [];
  const leaf = segments.length > 1 ? segments[segments.length - 1] : null;

  return { q, lower: q.toLowerCase(), single, terms, leaf };
}

/**
 * How much a word distinguishes one symbol from another in this repository.
 *
 * A word in half the symbols ("get", "self", "return") says almost nothing
 * about which one was meant; a word in three says nearly everything. This is
 * what lets function bodies be indexed whole, keywords included, without a
 * stop list for every language.
 */
function inverseFrequency(store, term, total) {
  if (!total) return 1;
  let df = 0;
  try {
    // Prefix range over the vocabulary: every indexed word starting with the
    // stem, which is exactly the set the stem will be matched against.
    df = store.get(
      'SELECT COALESCE(SUM(doc), 0) AS n FROM symbols_vocab WHERE term >= ? AND term < ?',
      term, term + '￿'
    )?.n ?? 0;
  } catch {
    return 1;
  }
  return Math.log(1 + total / (1 + Math.min(df, total)));
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

function wordsOf(text) {
  if (!text) return [];
  const out = [];
  for (const w of text.split(/[^\p{L}\p{N}_]+/u)) {
    if (!w) continue;
    out.push(w.toLowerCase());
    if (/[A-Z_]/.test(w)) out.push(...splitIdentifier(w));
  }
  return out;
}

const hasStem = (words, st) => {
  for (const w of words) if (w.startsWith(st)) return true;
  return false;
};

function scoreNode(node, plan, bodyHits) {
  const name = node.name ?? '';
  const nameLower = name.toLowerCase();
  const nameParts = splitIdentifier(name);

  // Lazily built: most candidates are decided by the name alone.
  let container, signature, doc;

  let sum = 0;
  let weight = 0;
  let matchedWeight = 0;
  let inName = 0;

  for (const term of plan.terms) {
    weight += term.idf;
    let field = 0;

    if (nameLower === term.raw) field = FIELD.nameExact;
    else if (nameParts.includes(term.raw)) field = FIELD.namePart;
    else if (hasStem(nameParts, term.stem)) field = FIELD.nameStem;
    else if (nameLower.includes(term.raw)) field = FIELD.nameSub;

    if (field) {
      inName++;
    } else {
      container ??= wordsOf(containerOf(node));
      if (hasStem(container, term.stem)) field = FIELD.container;
      else {
        signature ??= wordsOf(node.signature);
        if (hasStem(signature, term.stem)) field = FIELD.signature;
        else {
          doc ??= wordsOf(node.doc);
          if (hasStem(doc, term.stem)) field = FIELD.doc;
          else if (bodyHits.get(term.stem)?.has(node.id)) field = FIELD.body;
        }
      }
    }

    if (field) {
      matchedWeight += term.idf;
      sum += field * term.idf;
    }
  }

  let score;
  if (matchedWeight > 0) {
    // Squared: matching two of four query words is not half as good as
    // matching all four, it is a different and much weaker answer.
    const coverage = matchedWeight / weight;
    score = (sum / weight) * coverage * coverage;

    // A name the query accounts for completely is a better answer than a
    // longer name that merely contains it: `login` over `handleLoginRequest`.
    if (inName && nameParts.length) {
      score *= 0.75 + 0.25 * Math.min(1, inName / nameParts.length);
    }
  } else {
    // Proposed only by trigram overlap: a fragment or a misspelling. Worth
    // showing when nothing better exists, and never above a real word match.
    const share = trigramShare(plan.lower, nameLower);
    if (share < 0.5) return 0;
    score = FIELD.body * share;
  }

  if (plan.single) {
    if (name === plan.q) score *= 2;
    else if (nameLower === plan.lower) score *= 1.6;
    else if (nameLower.startsWith(plan.lower)) score *= 1.2;

    // `Class#method`: the name matched the last segment; the qualified name
    // has to carry the rest, or this is a different symbol of the same name.
    if (plan.leaf && name === plan.leaf) {
      score *= node.qname.toLowerCase().includes(plan.lower) ? 3 : 0.6;
    }
  }

  // Mild priors. A field or constant is less often the thing being looked for
  // than the function or type that owns the behaviour, and a test's helper
  // less often than the code under test. Small enough that a better textual
  // match always wins.
  if (node.kind !== 'function' && node.kind !== 'method' && node.kind !== 'class' &&
      node.kind !== 'interface' && node.kind !== 'type' && node.kind !== 'enum') {
    score *= 0.85;
  }
  // A field whose parent is a function is a key in an object literal written
  // inline — `{ recursive: true }`, a result object being returned. Indexed so
  // that members of a namespace object resolve, but almost never what a search
  // is for, and on a typical JavaScript file they outnumber everything else.
  if (node.kind === 'field' && LOCAL_FIELD.has(node.parent_kind)) score *= 0.5;
  if (SECONDARY_PATH.test(node.path)) score *= 0.85;
  if (node.is_exported) score *= 1.05;

  return score;
}

/** The part of a qualified name that is not the symbol's own name. */
function containerOf(node) {
  const q = node.qname ?? '';
  return q.endsWith(node.name) ? q.slice(0, q.length - node.name.length) : q;
}

function trigramShare(a, b) {
  const ta = trigrams(a);
  if (!ta.length) return 0;
  const tb = new Set(trigrams(b));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / ta.length;
}

// ---------------------------------------------------------------------------
// candidate strategies
// ---------------------------------------------------------------------------

/**
 * What every strategy returns for a candidate. The parent's kind is carried so
 * the scorer can tell a class's field from a key in an object literal inside a
 * function — see LOCAL_FIELD.
 */
const COLUMNS = `n.id, n.name, n.qname, n.kind, n.signature, n.doc, n.start_line,
                 n.end_line, n.rank, n.is_exported, f.path, f.lang, f.subproject,
                 p.kind AS parent_kind`;
const PARENT = 'LEFT JOIN nodes p ON p.id = n.parent_id';

function baseSelect(extra) {
  return `SELECT ${COLUMNS}
            FROM nodes n JOIN files f ON f.id = n.file_id ${PARENT}
           ${extra}`;
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function exactMatches(store, plan) {
  if (!plan.single) return [];
  // `n.id` is the deterministic tiebreak (MCP spec: stable ordering improves
  // prompt-cache hits). At the LIMIT boundary SQLite may drop a different tied
  // row each run, changing the candidate SET that reaches scoring; a total order
  // on (rank, id) makes the surviving set byte-stable.
  const names = plan.leaf ? [plan.q, plan.leaf] : [plan.q];
  const rows = [];
  for (const name of names) {
    rows.push(...store.all(
      baseSelect(`WHERE n.name = ? AND n.kind != 'module' ORDER BY n.rank DESC, n.id LIMIT 50`),
      name
    ));
  }
  return rows;
}

function prefixMatches(store, plan) {
  if (!plan.single || plan.q.length < 2) return [];
  return store.all(
    baseSelect(`WHERE n.name LIKE ? ESCAPE '\\' AND n.name != ? AND n.kind != 'module'
                ORDER BY n.rank DESC, n.id LIMIT 50`),
    `${escapeLike(plan.q)}%`, plan.q
  );
}

/**
 * Fallback for builds without FTS5.
 *
 * Scans `nodes` directly. Slower than an inverted index and without relevance
 * ranking, but correct — and the scorer supplies ordering. Split identifier
 * words are matched too, so "login" still finds "handleLogin", which is the
 * behaviour users would most notice losing.
 */
function likeMatches(store, plan) {
  if (!plan.terms.length) return [];

  // One OR group per term across name, qname, signature and doc.
  const clauses = [];
  const params = [];
  for (const term of plan.terms) {
    const like = `%${escapeLike(term.stem)}%`;
    clauses.push(`(n.name LIKE ? ESCAPE '\\' OR n.qname LIKE ? ESCAPE '\\'
                   OR n.signature LIKE ? ESCAPE '\\' OR n.doc LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like);
  }

  return store.all(
    baseSelect(`WHERE n.kind != 'module' AND (${clauses.join(' OR ')})
                ORDER BY n.rank DESC, n.id LIMIT 200`),
    ...params
  );
}

/**
 * Full-text candidates across names, split identifier words, signatures, docs
 * and function bodies.
 *
 * Run twice for a multi-word query: once requiring every word, so the symbols
 * that match the whole question are certain to be considered however common
 * its individual words are, and once requiring any, so a partial match is
 * still available when nothing matches everything.
 *
 * Terms are reduced to letters and digits before they reach FTS5, which treats
 * `-`, `*`, `"` and `:` as operators — an unescaped query like "get-user" is a
 * syntax error rather than a search.
 */
function ftsMatches(store, plan, mode) {
  const terms = plan.terms
    .map((t) => t.stem.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((t) => t.length >= 2);
  if (!terms.length) return [];

  const expr = terms.map((t) => `"${t}"*`).join(mode === 'AND' ? ' AND ' : ' OR ');

  try {
    return store.all(
      `SELECT ${COLUMNS}
         FROM symbols_fts s
         JOIN fts_map m ON m.rowid = s.rowid
         JOIN nodes n ON n.id = m.node_id
         JOIN files f ON f.id = n.file_id ${PARENT}
        WHERE symbols_fts MATCH ? AND n.kind != 'module'
        ORDER BY ${BM25}, n.id LIMIT ?`,
      expr, mode === 'AND' ? 150 : 250
    );
  } catch {
    // A malformed FTS expression must degrade to "no text hits", never take
    // down the whole search.
    return [];
  }
}

/**
 * For each query word, the candidates whose body uses it.
 *
 * The full-text table stores no text (it is contentless, to keep the index a
 * fraction of the size of the source), so the scorer cannot look at a body
 * the way it looks at a name. It asks the index instead.
 */
function bodyMatches(store, plan, candidates) {
  const hits = new Map();
  if (!store.hasFts5 || !candidates.size) return hits;

  const ids = JSON.stringify([...candidates.keys()]);
  for (const term of plan.terms) {
    const clean = term.stem.replace(/[^\p{L}\p{N}_]/gu, '');
    if (clean.length < 2) continue;
    try {
      const rows = store.all(
        `SELECT m.node_id AS id FROM symbols_fts s JOIN fts_map m ON m.rowid = s.rowid
          WHERE symbols_fts MATCH ?
            AND m.node_id IN (SELECT value FROM json_each(?))`,
        `body : "${clean}"*`, ids
      );
      hits.set(term.stem, new Set(rows.map((r) => r.id)));
    } catch {
      // No body information for this word; it can still match elsewhere.
    }
  }
  return hits;
}

/**
 * Functions whose body mentions the query as one identifier.
 *
 * `MAX_RETRIES` is indexed as the adjacent words "max retries" and
 * `retryCount` as the single word "retrycount" alongside its parts, so both
 * spellings of "this exact name" are a phrase the index can answer directly.
 */
function identifierUsers(store, plan) {
  const none = { rows: [], ids: new Set() };
  if (!store.hasFts5 || !plan.single) return none;

  const words = plan.q.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => w.toLowerCase());
  if (!words.length || words.join('').length < 4) return none;

  try {
    const rows = store.all(
      `SELECT ${COLUMNS}
         FROM symbols_fts s
         JOIN fts_map m ON m.rowid = s.rowid
         JOIN nodes n ON n.id = m.node_id
         JOIN files f ON f.id = n.file_id ${PARENT}
        WHERE symbols_fts MATCH ? AND n.kind != 'module'
        ORDER BY n.rank DESC, n.id LIMIT 60`,
      `body : "${words.join(' ')}"`
    );
    return { rows, ids: new Set(rows.map((r) => r.id)) };
  } catch {
    return none;
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
  const rows = store.all(
    `SELECT id, path, lang, skip_reason, subproject FROM files
      WHERE parsed = 0 AND path LIKE ? ESCAPE '\\'
      ORDER BY path LIMIT 30`,
    `%${escapeLike(q)}%`
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

/**
 * Substring matches via trigram overlap — what word-based full text cannot do:
 * `ogin` inside `handleLogin`, or a name with a letter wrong.
 *
 * Only for a single-word query. The trigrams of a whole sentence overlap with
 * half the names in a repository and say nothing about any of them.
 */
function trigramMatches(store, plan) {
  if (!plan.single) return [];
  const tris = trigrams(plan.lower);
  if (!tris.length) return [];

  const holes = tris.map(() => '?').join(',');
  // Require most trigrams to match, or every short query matches everything.
  const threshold = Math.max(1, Math.ceil(tris.length * 0.7));

  return store.all(
    `SELECT ${COLUMNS}
       FROM trigrams t
       JOIN nodes n ON n.id = t.node_id
       JOIN files f ON f.id = n.file_id ${PARENT}
      WHERE t.tri IN (${holes}) AND n.kind != 'module'
      GROUP BY n.id
     HAVING COUNT(DISTINCT t.tri) >= ?
      ORDER BY COUNT(DISTINCT t.tri) DESC, n.rank DESC, n.id
      LIMIT 40`,
    ...tris, threshold
  );
}

// ---------------------------------------------------------------------------
// suggestions for a miss
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/** Longest signature shown under a hit before it is cut. */
const SIGNATURE_CHARS = 120;

/**
 * A symbol's name as shown next to its location.
 *
 * Qualified names begin with the file path (`src/a.js::Class#method`). Printed
 * beside `src/a.js:12` that path is on the line twice, and it was nearly half
 * of what every search and every caller list cost. Without it nothing is lost:
 * the location still says which file, and what remains (`Class#method`) is
 * still accepted wherever a symbol is asked for.
 */
export function displayName(node) {
  const q = node.qname ?? node.name ?? '';
  const prefix = `${node.path}::`;
  return q.startsWith(prefix) ? q.slice(prefix.length) : q;
}

/** `path:start-end`, or `path:line` for a one-line symbol. */
export function location(node) {
  const { path, start_line: start, end_line: end } = node;
  if (start == null) return path;
  return end != null && end !== start ? `${path}:${start}-${end}` : `${path}:${start}`;
}

/**
 * Render search hits as compact lines.
 *
 * One line per hit — where it is, what it is, what it is called — and its
 * signature beneath when that says more than the name does. The location is a
 * line *range*, so the agent can read exactly that symbol instead of the file.
 * Enough to choose what to read next, and nothing more.
 */
export function renderHits(hits, { showWhy = false } = {}) {
  const lines = [];
  // `search()` attaches a filterNote when a filter emptied an otherwise
  // non-empty result. Rendering it here means every consumer (CLI find, MCP
  // find) shows the guidance for free, and a silent-empty truncation is
  // impossible.
  if (hits.filterNote) lines.push(hits.filterNote);

  for (const hit of hits) {
    const n = hit.node;
    const why = showWhy ? `  [${hit.why.join('+')}]` : '';

    if (n.kind === 'file') {
      const reason = n.skipReason ? `  (${n.skipReason})` : '';
      lines.push(`${n.path}  file${reason}${why}`);
      continue;
    }

    const name = displayName(n);
    lines.push(`${location(n)}  ${n.kind} ${name}${why}`);

    const sig = n.signature?.replace(/\s+/g, ' ').trim();
    if (sig && sig !== n.name && sig !== name) {
      lines.push(`    ${sig.length > SIGNATURE_CHARS ? sig.slice(0, SIGNATURE_CHARS - 1) + '…' : sig}`);
    }
  }

  if (hits.weaker > 0) {
    lines.push(hits.cutByLimit
      ? `(+${hits.weaker} more, some as good as these; narrow with path or kind, or raise limit)`
      : `(+${hits.weaker} weaker match${hits.weaker === 1 ? '' : 'es'} not shown; pass limit to list them)`);
  }
  return lines;
}
