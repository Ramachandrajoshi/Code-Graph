/**
 * Dependency documentation lookup.
 *
 * The differentiating idea: because the graph already records edges from
 * project code into external symbols, we know which parts of a dependency this
 * repo actually uses. So `docs express` returns the twelve functions this
 * project calls — ranked by how often — rather than the entire Express API.
 *
 * No documentation website can do that, and it is exactly the subset an agent
 * needs.
 */

import { estimate } from '../core/tokens.js';

/**
 * Standard libraries. Real to the graph, but not what someone means by
 * "what does this project depend on".
 */
const STDLIB_ECOSYSTEMS = new Set([
  'builtin', 'node', 'python-stdlib', 'go-stdlib', 'rust-std', 'jdk',
]);

/**
 * Dependencies ranked by how much this project leans on them.
 *
 * Third-party packages sort ahead of standard libraries regardless of raw usage
 * counts. `fs` and `path` are used more than any npm package in almost every
 * Node project, and letting them head the list buries the answer the question
 * was actually asking.
 */
export function listDependencies(store, { limit = 25, includeStdlib = true } = {}) {
  const rows = store.all(
    `SELECT package, ecosystem, SUM(use_count) AS uses, COUNT(*) AS symbols
       FROM externals
      GROUP BY package, ecosystem
     HAVING uses > 0
      ORDER BY uses DESC`
  );

  const third = [];
  const std = [];
  for (const row of rows) {
    row.stdlib = STDLIB_ECOSYSTEMS.has(row.ecosystem);
    (row.stdlib ? std : third).push(row);
  }

  const ordered = includeStdlib ? [...third, ...std] : third;
  return ordered.slice(0, limit);
}

/**
 * Look up one package's API as used here.
 *
 * Falls back gracefully: if no documentation has been extracted yet, the usage
 * data alone is still useful, and saying so is better than an empty answer that
 * looks like the package is unused.
 */
export function lookupDocs(store, config, { pkg, symbol = null, top = 15 }) {
  const rows = symbol
    ? store.all(
        `SELECT * FROM externals WHERE package = ? AND symbol = ? ORDER BY use_count DESC`,
        pkg, symbol
      )
    : store.all(
        `SELECT * FROM externals WHERE package = ? AND symbol != ''
          ORDER BY use_count DESC, symbol LIMIT ?`,
        pkg, top
      );

  if (!rows.length) {
    const known = store.get(
      'SELECT COUNT(*) n FROM externals WHERE package = ?', pkg
    ).n;
    if (!known) {
      const near = store.all(
        'SELECT DISTINCT package FROM externals WHERE package LIKE ? LIMIT 5', `%${pkg}%`
      );
      return {
        lines: [
          `'${pkg}' is not a dependency of this project.`,
          ...(near.length ? ['', 'similar names: ' + near.map((n) => n.package).join(', ')] : []),
        ],
        tokens: 20,
      };
    }
    return { lines: [`'${pkg}' is imported but no symbols from it are used directly.`], tokens: 15 };
  }

  const ecosystem = rows[0].ecosystem;
  const version = rows.find((r) => r.version)?.version;
  const lines = [`${pkg}${version ? '@' + version : ''}  (${ecosystem})`, ''];

  for (const row of rows) {
    const uses = row.use_count ? `  ${row.use_count}x` : '';
    lines.push(`${row.symbol}${uses}`);
    if (row.signature) lines.push(`  ${row.signature}`);
    if (row.doc) lines.push(`  ${truncate(row.doc, 160)}`);

    // Where it is used here. This is the part an agent cannot get from a docs
    // site, and it is usually the fastest route to a working example.
    const sites = usageSites(store, row.id, 3);
    for (const s of sites) lines.push(`    used: ${s.path}:${s.line}  ${s.qname}`);
  }

  const undocumented = rows.filter((r) => !r.signature).length;
  if (undocumented === rows.length) {
    lines.push(
      '',
      'No signatures extracted yet. Run `cgraph deps` to read them from node_modules ' +
        'or fetch them from the registry.'
    );
  }

  return { lines, tokens: estimate(lines.join('\n')) };
}

function usageSites(store, externalId, limit) {
  return store.all(
    `SELECT f.path, e.line, n.qname
       FROM edges e
       JOIN files f ON f.id = e.file_id
       JOIN nodes n ON n.id = e.src_id
      WHERE e.ext_id = ?
      ORDER BY e.line LIMIT ?`,
    externalId, limit
  );
}

function truncate(text, n) {
  return text.length <= n ? text : text.slice(0, n - 1) + '…';
}
