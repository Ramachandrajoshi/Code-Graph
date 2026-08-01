/**
 * Graph traversal.
 *
 * This is the capability with no shell equivalent. "What breaks if I change
 * this function" is not a text search — it is a transitive closure over the
 * reverse call graph, and an agent armed with grep can only approximate it by
 * reading everything that mentions the name.
 *
 * Every traversal reports edge confidence, because an impact set built from
 * guesses needs to be read differently from one built from proven edges.
 */

const DIRECTIONS = new Set(['callers', 'callees', 'importers', 'imports', 'impact', 'path', 'explore']);

export function isValidDirection(dir) {
  return DIRECTIONS.has(dir);
}

/**
 * Direct callers of a symbol: who would break if its contract changed.
 */
export function callers(store, nodeId, { limit = 50, minConfidence = null } = {}) {
  const filter = minConfidence === 'EXACT' ? "AND e.confidence = 'EXACT'" : '';
  // Grouped by caller, not by call site. A function that calls the target from
  // five lines is one caller; listing it five times spends tokens repeating a
  // fact the agent already has. The site count is kept because "called 5 times
  // from here" is genuinely useful, and costs three characters.
  //
  // MAX(e.confidence) is the weakest-link aggregate, not the strongest: 'I' >
  // 'E' lexicographically, so one INFERRED site among several EXACT ones marks
  // the whole caller INFERRED. MIN would let a single proven site launder the
  // rest into looking proven too.
  return store.all(
    `SELECT n.id, n.qname, n.kind, n.start_line, n.end_line, n.rank, f.path,
            MIN(e.line) AS line, COUNT(*) AS sites,
            MAX(e.confidence) AS confidence, MIN(e.kind) AS edge_kind
       FROM edges e
       JOIN nodes n ON n.id = e.src_id
       JOIN files f ON f.id = n.file_id
      WHERE e.dst_id = ? ${filter}
      GROUP BY n.id
      ORDER BY n.rank DESC, f.path
      LIMIT ?`,
    nodeId, limit
  );
}

/** What this symbol calls. */
export function callees(store, nodeId, { limit = 50 } = {}) {
  const internal = store.all(
    `SELECT DISTINCT n.id, n.qname, n.kind, n.start_line, n.end_line, n.rank,
            f.path, e.confidence, e.kind AS edge_kind, e.line
       FROM edges e
       JOIN nodes n ON n.id = e.dst_id
       JOIN files f ON f.id = n.file_id
      WHERE e.src_id = ?
      ORDER BY e.line
      LIMIT ?`,
    nodeId, limit
  );

  const external = store.all(
    `SELECT DISTINCT x.package, x.symbol, x.ecosystem, e.confidence, e.line
       FROM edges e JOIN externals x ON x.id = e.ext_id
      WHERE e.src_id = ?
      ORDER BY e.line
      LIMIT ?`,
    nodeId, limit
  );

  return { internal, external };
}

/** Files that import the given file. */
export function importers(store, fileId, { limit = 100 } = {}) {
  return store.all(
    `SELECT DISTINCT f.id, f.path, i.spec, i.symbol, i.line
       FROM imports i JOIN files f ON f.id = i.file_id
      WHERE i.resolved_file_id = ?
      ORDER BY f.path
      LIMIT ?`,
    fileId, limit
  );
}

/**
 * Transitive impact: everything that could be affected by changing this symbol.
 *
 * Breadth-first over reverse edges so results come back in "distance from the
 * change" order, which is how a reviewer wants to read them — direct callers
 * first, ripple effects after.
 *
 * The frontier is capped. An unbounded closure on a central utility can reach
 * most of a repo, and returning four thousand symbols to an agent costs more
 * tokens than the naive approach it replaced.
 */
export function impact(store, nodeId, { depth = 3, limit = 200, minConfidence = null } = {}) {
  const seen = new Map([[nodeId, 0]]);
  const out = [];
  let frontier = [nodeId];

  const filter = minConfidence === 'EXACT' ? "AND e.confidence = 'EXACT'" : '';

  for (let d = 1; d <= depth && frontier.length && out.length < limit; d++) {
    const holes = frontier.map(() => '?').join(',');
    const rows = store.all(
      `SELECT DISTINCT n.id, n.qname, n.kind, n.start_line, n.rank, f.path,
              e.confidence, e.dst_id
         FROM edges e
         JOIN nodes n ON n.id = e.src_id
         JOIN files f ON f.id = n.file_id
        WHERE e.dst_id IN (${holes}) ${filter}
        ORDER BY n.rank DESC`,
      ...frontier
    );

    const next = [];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.set(row.id, d);
      out.push({ ...row, distance: d });
      next.push(row.id);
      if (out.length >= limit) break;
    }
    frontier = next;
  }

  return { nodes: out, truncated: out.length >= limit };
}

/**
 * Shortest call path between two symbols.
 *
 * Bidirectional BFS: the forward and backward frontiers each explore roughly
 * half the depth, which on a graph with high fan-out is dramatically cheaper
 * than a one-directional search. "How does the request handler end up touching
 * the database" is answerable in milliseconds this way.
 */
export function shortestPath(store, fromId, toId, { maxDepth = 8 } = {}) {
  if (fromId === toId) return [fromId];

  const forwardPrev = new Map([[fromId, null]]);
  const backwardNext = new Map([[toId, null]]);
  let forward = [fromId];
  let backward = [toId];

  for (let d = 0; d < maxDepth; d++) {
    if (forward.length) {
      const step = expand(store, forward, forwardPrev, backwardNext, 'forward');
      if (step.meet !== null) return buildPath(step.meet, forwardPrev, backwardNext);
      forward = step.next;
    }
    if (backward.length) {
      const step = expand(store, backward, backwardNext, forwardPrev, 'backward');
      if (step.meet !== null) return buildPath(step.meet, forwardPrev, backwardNext);
      backward = step.next;
    }
    if (!forward.length && !backward.length) break;
  }

  return null;
}

/**
 * Expand one BFS level. Returns the next frontier plus the meeting node, if the
 * two searches touched. Returning both keeps this function pure — an earlier
 * version stashed the frontier in module scope, which made concurrent
 * traversals (two MCP requests in flight) silently corrupt each other.
 */
function expand(store, frontier, visited, otherSide, direction) {
  const holes = frontier.map(() => '?').join(',');
  const sql = direction === 'forward'
    ? `SELECT src_id AS from_id, dst_id AS to_id FROM edges
        WHERE src_id IN (${holes}) AND dst_id IS NOT NULL`
    : `SELECT dst_id AS from_id, src_id AS to_id FROM edges
        WHERE dst_id IN (${holes})`;

  const rows = store.all(sql, ...frontier);
  const next = [];

  for (const row of rows) {
    if (visited.has(row.to_id)) continue;
    visited.set(row.to_id, row.from_id);
    next.push(row.to_id);
    if (otherSide.has(row.to_id)) return { next, meet: row.to_id };
  }

  return { next, meet: null };
}

function buildPath(meet, forwardPrev, backwardNext) {
  const head = [];
  for (let id = meet; id !== undefined && id !== null; id = forwardPrev.get(id)) {
    head.unshift(id);
    if (!forwardPrev.has(id)) break;
  }

  const tail = [];
  for (let id = backwardNext.get(meet); id !== undefined && id !== null; id = backwardNext.get(id)) {
    tail.push(id);
  }

  return [...head, ...tail];
}

/** Hydrate node ids into displayable rows, preserving order. */
export function hydrate(store, ids) {
  if (!ids?.length) return [];
  const holes = ids.map(() => '?').join(',');
  const rows = store.all(
    `SELECT n.id, n.qname, n.kind, n.start_line, n.rank, f.path
       FROM nodes n JOIN files f ON f.id = n.file_id
      WHERE n.id IN (${holes})`,
    ...ids
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}
