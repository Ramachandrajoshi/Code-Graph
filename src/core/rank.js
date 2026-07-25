/**
 * Symbol ranking.
 *
 * Search without ranking is nearly useless on a real repo: a query for "config"
 * matches ninety symbols, and the agent reads them in arbitrary order. Rank is
 * what turns a match list into an answer.
 *
 * PageRank over the call graph, because importance in code is recursive in
 * exactly the way PageRank models: a function called by many important
 * functions is important. Raw fan-in alone over-ranks trivial utilities
 * (every file calls the logger) and under-ranks entry points, which are called
 * rarely but reach everything.
 */

const DAMPING = 0.85;
const ITERATIONS = 20;

/**
 * Compute and store a rank for every node.
 *
 * Runs over the in-memory edge list rather than querying per node: on a repo
 * with 100k edges, 20 iterations of per-node SQL would be millions of queries.
 */
export function computeRanks(store) {
  const nodes = store.all('SELECT id FROM nodes');
  if (!nodes.length) return { nodes: 0, iterations: 0 };

  const index = new Map();
  for (let i = 0; i < nodes.length; i++) index.set(nodes[i].id, i);

  const n = nodes.length;
  const outDegree = new Int32Array(n);
  const edgeSrc = [];
  const edgeDst = [];

  for (const e of store.all('SELECT src_id, dst_id FROM edges WHERE dst_id IS NOT NULL')) {
    const s = index.get(e.src_id);
    const d = index.get(e.dst_id);
    if (s === undefined || d === undefined) continue;
    edgeSrc.push(s);
    edgeDst.push(d);
    outDegree[s]++;
  }

  let rank = new Float64Array(n).fill(1 / n);
  let next = new Float64Array(n);

  for (let iter = 0; iter < ITERATIONS; iter++) {
    next.fill((1 - DAMPING) / n);

    // Dangling nodes (nothing calls out) would leak rank out of the system, so
    // their mass is redistributed uniformly — the standard correction.
    let dangling = 0;
    for (let i = 0; i < n; i++) if (outDegree[i] === 0) dangling += rank[i];
    const spill = (DAMPING * dangling) / n;

    for (let i = 0; i < n; i++) next[i] += spill;
    for (let e = 0; e < edgeSrc.length; e++) {
      next[edgeDst[e]] += (DAMPING * rank[edgeSrc[e]]) / outDegree[edgeSrc[e]];
    }

    [rank, next] = [next, rank];
  }

  // Normalize to 0..1 so the number is comparable across repos and readable in
  // output. Raw PageRank values scale with 1/n and mean nothing to a reader.
  let max = 0;
  for (let i = 0; i < n; i++) if (rank[i] > max) max = rank[i];
  const scale = max > 0 ? 1 / max : 0;

  store.transaction(() => {
    const update = store.stmt('UPDATE nodes SET rank = ? WHERE id = ?');
    for (let i = 0; i < n; i++) update.run(rank[i] * scale, nodes[i].id);
  });

  return { nodes: n, iterations: ITERATIONS, edges: edgeSrc.length };
}

/**
 * Fan-in / fan-out for one symbol. Cheap, exact, and what "how connected is
 * this" usually means in a review conversation.
 */
export function degree(store, nodeId) {
  const callers = store.get(
    'SELECT COUNT(DISTINCT src_id) n FROM edges WHERE dst_id = ?', nodeId
  ).n;
  const callees = store.get(
    'SELECT COUNT(DISTINCT dst_id) n FROM edges WHERE src_id = ? AND dst_id IS NOT NULL', nodeId
  ).n;
  return { callers, callees };
}
