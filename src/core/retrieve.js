/**
 * Retrieval and rendering.
 *
 * Everything here optimises for one number: tokens delivered per question
 * answered. Three rules follow from that and are applied throughout:
 *
 *   1. Compact text, never JSON. Braces, quotes and repeated keys are ~35% of a
 *      JSON payload and carry no information the agent needs.
 *   2. Say where, not what. A line number plus a signature lets the agent decide
 *      whether to spend tokens on the body; dumping the body pre-empts that.
 *   3. Truncate loudly. A silently shortened answer reads as complete, and the
 *      agent stops looking. Every truncation states what was dropped.
 */

import fs from 'node:fs';
import { absFromRoot } from './paths.js';
import { estimate, fitToBudget } from './tokens.js';

/** Single-character kind markers keep the outline narrow. */
const KIND_MARK = {
  module: 'M', class: 'C', interface: 'I', function: 'f', method: 'm',
  field: 'p', var: 'v', const: 'k', type: 't', enum: 'e', block: 'b',
};

/**
 * The one marker for an edge's confidence: a leading space for proven (EXACT)
 * edges, `!` for anything inferred.
 *
 * The `!` is load-bearing: a reader is told to verify every `!` edge before
 * relying on it, because an inferred edge is only a name match, not a proven
 * import. The CLI and the MCP server each used to hard-code this same ternary,
 * so a confidence-tier change that touched one site would silently desync the
 * two legends and quietly break that contract. Centralizing it here — a module
 * both layers already import — keeps a single definition of the marker. Output
 * is byte-for-byte what both call sites produced before.
 */
export function formatConfidence(confidence) {
  return confidence === 'EXACT' ? ' ' : '!';
}

/**
 * Outline of a file: its symbol hierarchy, one line per symbol.
 *
 * This is the single highest-leverage output in the tool. A 142-line file costs
 * ~1,800 tokens to read and ~90 to outline, and the outline is usually enough to
 * decide which one symbol is worth reading in full.
 */
export function outlineFile(store, file, { budget = 0, kinds = null, maxDepth = 99, detail = 'outline' } = {}) {
  const nodes = store.all(
    `SELECT id, parent_id, kind, name, signature, doc, start_line, end_line, tok, visibility, is_exported
       FROM nodes WHERE file_id = ? ORDER BY start_byte, id`,
    file.id
  );

  const depths = new Map();
  const lines = [];
  const header = `${file.path}  L${file.loc} ~${compactTokens(file.tok)}`;

  for (const n of nodes) {
    if (n.kind === 'module') { depths.set(n.id, -1); continue; }

    const parentDepth = depths.get(n.parent_id) ?? -1;
    const depth = parentDepth + 1;
    depths.set(n.id, depth);

    if (depth > maxDepth) continue;
    if (kinds && !kinds.includes(n.kind)) continue;

    lines.push(...renderSymbol(n, depth, detail));
  }

  if (!lines.length) {
    return {
      lines: [header, '  (no symbols extracted)'],
      tokens: estimate(header) + 8,
      dropped: 0,
      baseline: file.tok,
    };
  }

  const fitted = fitToBudget(lines, budget ? budget - estimate(header) : null);
  const out = [header, ...fitted.lines];
  if (fitted.dropped) {
    out.push(`  ... ${fitted.dropped} more symbols (raise --budget to see them)`);
  }

  return {
    lines: out,
    tokens: fitted.tokens + estimate(header),
    dropped: fitted.dropped,
    baseline: file.tok,
  };
}

/**
 * Render one symbol as outline line(s).
 *
 * Returns an ARRAY so a `detail: 'full'` outline can append a doc-comment line
 * under the symbol without changing the single-line `detail: 'outline'` output.
 * In `outline` mode (the default, and the mode every existing caller is in) it
 * returns exactly the one line it returned before — byte-for-byte. The extra
 * doc line is opt-in so the default outline stays as cheap as it has always
 * been; `full` trades tokens for context the agent can read without opening
 * the file.
 */
function renderSymbol(n, depth, detail = 'outline') {
  const indent = '  '.repeat(depth);
  const line = String(n.start_line).padStart(4);
  const mark = KIND_MARK[n.kind] ?? '?';

  // A private marker is one character and changes how an agent treats the
  // symbol, so it earns its place; a full 'private' keyword does not.
  const vis = n.visibility === 'private' ? '-' : n.visibility === 'protected' ? '#' : '';
  const body = n.signature || n.name;

  const out = [`${line} ${mark} ${indent}${vis}${body}`];

  // `full` adds the doc comment where present. The signature is already the
  // outline's `body`, so the incremental detail is the prose.
  if (detail === 'full' && n.doc) {
    const note = oneLine(n.doc);
    if (note) out.push(`${' '.repeat(5 + indent.length)}${note}`);
  }
  return out;
}

/** Collapse a doc comment to one indented line, trimming comment markers. */
function oneLine(doc) {
  const text = String(doc).replace(/\s+/g, ' ').trim().replace(/^\/\*+|\*+\/$/g, '').trim();
  return text ? `// ${text}` : '';
}

/**
 * Directory-level map: subdirectories and files with their token cost.
 *
 * Answers "what is in this project and where should I look" without an agent
 * running `ls` five times and reading three files to orient itself.
 */
export function outlineDir(store, prefix, { depth = 1, budget = 0 } = {}) {
  const like = prefix ? `${prefix}/%` : '%';
  const files = store.all(
    `SELECT path, lang, loc, tok, parsed, subproject, skip_reason FROM files
      WHERE path LIKE ? ORDER BY path`,
    like
  );

  if (!files.length) return { lines: [`no indexed files under '${prefix || "."}'`], tokens: 8, dropped: 0, baseline: 0 };

  const base = prefix ? prefix.split('/').length : 0;
  const groups = new Map();
  const direct = [];

  for (const f of files) {
    const parts = f.path.split('/');
    if (parts.length - base <= depth) {
      direct.push(f);
      continue;
    }
    const key = parts.slice(0, base + depth).join('/');
    const g = groups.get(key) ?? { files: 0, tok: 0, loc: 0, langs: new Set(), subprojects: new Set() };
    g.files++; g.tok += f.tok; g.loc += f.loc;
    if (f.lang) g.langs.add(f.lang);
    if (f.subproject) g.subprojects.add(f.subproject);
    groups.set(key, g);
  }

  const lines = [];
  // Deterministic order (MCP spec: stable ordering improves prompt-cache hits):
  // equal token-cost groups/files would otherwise shuffle between runs. The
  // primary ranking (tok desc) is unchanged; ties fall back to name/path so the
  // listing is byte-identical across calls.
  for (const [dir, g] of [...groups].sort((a, b) => b[1].tok - a[1].tok || a[0].localeCompare(b[0]))) {
    const langs = [...g.langs].slice(0, 3).join(',');
    const subs = [...g.subprojects].slice(0, 3).join(', ');
    lines.push(
      `${dir}/  ${g.files} files  ~${compactTokens(g.tok)}${langs ? '  ' + langs : ''}${subs ? '  [' + subs + ']' : ''}`
    );
  }
  for (const f of direct.sort((a, b) => b.tok - a.tok || a.path.localeCompare(b.path))) {
    // The reason, not just the fact of skipping: an agent (or a human staring
    // at a run that "got stuck") should be able to tell an intentionally
    // skipped image from a parse failure without a separate `doctor` call.
    const note = f.parsed ? '' : `  (${f.skip_reason ?? 'not parsed'})`;
    const sub = f.subproject ? `  [${f.subproject}]` : '';
    lines.push(`${f.path}  L${f.loc} ~${compactTokens(f.tok)}${note}${sub}`);
  }

  const totalTok = files.reduce((a, f) => a + f.tok, 0);
  const header = `${prefix || '.'}  ${files.length} files  ~${compactTokens(totalTok)} total`;

  // Surfaced once at the root: an agent orienting itself in a fleet-of-repos
  // layout should see this before it starts reading directory groups one by
  // one, not discover it piecemeal from per-group tags.
  const subLine = !prefix ? (() => {
    const all = store.listSubprojects();
    return all.length ? [`sub-projects: ${all.join(', ')}`] : [];
  })() : [];

  const fitted = fitToBudget([...subLine, ...lines], budget ? budget - estimate(header) : null);
  const out = [header, ...fitted.lines];
  if (fitted.dropped) out.push(`... ${fitted.dropped} more entries`);

  return {
    lines: out,
    tokens: fitted.tokens + estimate(header),
    dropped: fitted.dropped,
    baseline: totalTok,
  };
}

/**
 * Find a symbol by name or qualified name.
 * Exact qname first, then exact name, then a suffix match on qname, so that
 * `LoginService#login` and `login` both resolve without ambiguity games.
 */
export function findSymbol(store, query, { limit = 10 } = {}) {
  // `n.id` is the deterministic tiebreak on every branch (MCP spec: stable
  // ordering improves prompt-cache hits). `map`(symbol) renders the first match,
  // so a rank tie here must not pick a different symbol across runs. The primary
  // ranking (rank, and tok on the name branch) is unchanged; only ties are made
  // stable.
  const exactQ = store.all(
    `SELECT n.*, f.path FROM nodes n JOIN files f ON f.id = n.file_id
      WHERE n.qname = ? ORDER BY n.rank DESC, n.id LIMIT ?`,
    query, limit
  );
  if (exactQ.length) return exactQ;

  const exactName = store.all(
    `SELECT n.*, f.path FROM nodes n JOIN files f ON f.id = n.file_id
      WHERE n.name = ? ORDER BY n.rank DESC, n.tok DESC, n.id LIMIT ?`,
    query, limit
  );
  if (exactName.length) return exactName;

  return store.all(
    `SELECT n.*, f.path FROM nodes n JOIN files f ON f.id = n.file_id
      WHERE n.qname LIKE ? ORDER BY n.rank DESC, n.id LIMIT ?`,
    `%${query}%`, limit
  );
}

/**
 * Read a symbol's source.
 *
 * Bodies are sliced from disk by byte offset rather than stored in the database:
 * duplicating the repo into SQLite would triple the index size for content the
 * filesystem already has, and it would go stale the moment a file changed.
 */
export function readSymbol(store, root, node, { mode = 'body', budget = 0 } = {}) {
  const file = store.get('SELECT * FROM files WHERE id = ?', node.file_id);
  const header = `${file.path}:${node.start_line}-${node.end_line}  ${node.kind} ${node.name}`;

  if (mode === 'signature') {
    const lines = [header];
    if (node.doc) lines.push(`  ${node.doc}`);
    if (node.signature) lines.push(`  ${node.signature}`);
    return { lines, tokens: estimate(lines.join('\n')), dropped: 0, baseline: file.tok };
  }

  let source;
  try {
    source = fs.readFileSync(absFromRoot(root, file.path), 'utf8');
  } catch (err) {
    return {
      lines: [header, `  (file unreadable: ${err.code ?? err.message} — index may be stale)`],
      tokens: 20, dropped: 0, baseline: 0,
    };
  }

  // A file edited since indexing invalidates byte offsets. Falling back to line
  // slicing keeps the answer roughly right instead of returning garbage from the
  // middle of an unrelated function.
  const stale = source.length < node.end_byte;
  const body = stale
    ? source.split('\n').slice(node.start_line - 1, node.end_line).join('\n')
    : source.slice(lineStart(source, node.start_byte), node.end_byte);

  const bodyLines = body.split('\n').map((l, i) => `${String(node.start_line + i).padStart(4)} ${l}`);
  const fitted = fitToBudget(bodyLines, budget ? budget - estimate(header) : null);

  const out = [header];
  // `kind: 'lines'` is a synthesized pseudo-node for an explicit path:start-end
  // query (see readRange in cli/commands/read.js and toolRead in mcp/server.js)
  // — it always forces the line-based path via end_byte, so `stale` there
  // reflects the query shape, not actual index staleness, and warning about
  // staleness would be a false alarm on a freshly built index.
  if (stale && node.kind !== 'lines') {
    out.push('  (index is stale; showing line-based slice — run `cgraph update`)');
  }
  out.push(...fitted.lines);
  if (fitted.dropped) {
    out.push(`  ... ${fitted.dropped} more lines, through line ${node.end_line} (raise --budget for the rest)`);
  }

  return {
    lines: out,
    tokens: fitted.tokens + estimate(header),
    dropped: fitted.dropped,
    baseline: file.tok,
  };
}

/**
 * Byte offset of the start of the line containing `offset`.
 *
 * A definition node begins at the keyword (`function`), not at the modifiers
 * that precede it (`export`, `public static`, decorators are separate). Slicing
 * from the node offset therefore prints content that does not match the line
 * number printed beside it — and an agent that edits by line number acts on
 * that mismatch. Snapping to the line start keeps the two in agreement, and
 * incidentally restores `export`, which tells the reader whether the symbol is
 * public API.
 */
function lineStart(source, offset) {
  const nl = source.lastIndexOf('\n', Math.max(0, offset - 1));
  return nl === -1 ? 0 : nl + 1;
}

function compactTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
