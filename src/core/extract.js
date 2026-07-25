/**
 * Capture -> graph extraction.
 *
 * Tree-sitter queries produce a flat list of matches. This turns that into the
 * hierarchy the tool is built around (module -> class -> method -> block) and
 * attaches every reference to the definition that encloses it.
 *
 * The containment pass is a single sorted sweep with a stack rather than nested
 * range comparisons: definitions nest strictly, so sorting by start position and
 * popping on end position is both correct and linear. Doing it with pairwise
 * containment checks is O(n^2) and noticeably slow on large generated files.
 *
 * Language-specific behavior arrives only through `pack` hooks. Nothing in this
 * file knows what language it is looking at.
 */

import { estimate } from './tokens.js';

/** Capture prefixes we understand. Packs may emit any suffix after the dot. */
const DEF_PREFIX = 'definition.';
const REF_PREFIX = 'reference.';

/**
 * Map a capture suffix onto a node kind. Packs are free to invent suffixes; an
 * unrecognised one is kept verbatim so a third-party pack can add, say,
 * `definition.trait` without touching core.
 */
const KIND_ALIASES = {
  func: 'function',
  fn: 'function',
  def: 'function',
  meth: 'method',
  cls: 'class',
  struct: 'class',
  constant: 'const',
  variable: 'var',
  iface: 'interface',
};

function normalizeKind(suffix) {
  return KIND_ALIASES[suffix] ?? suffix;
}

/**
 * Extract graph data for one file.
 *
 * @param {object} args
 * @param {string} args.path      repo-relative POSIX path
 * @param {string} args.source    file contents
 * @param {object} args.captures  result of ParserHost.run
 * @param {object} args.pack      language pack (hooks are optional)
 * @returns {{nodes: Array, refs: Array, imports: Array}}
 */
export function extract({ path, source, captures, pack }) {
  const definitions = [];
  const references = [];

  for (const match of captures.tags ?? []) {
    const record = classify(match);
    if (!record) continue;
    if (record.role === 'definition') definitions.push(record);
    else references.push(record);
  }

  // Outer definitions must be visited before inner ones, so ties on start
  // position break toward the wider range.
  definitions.sort((a, b) => a.startByte - b.startByte || b.endByte - a.endByte);
  references.sort((a, b) => a.startByte - b.startByte);

  dedupeDefinitions(definitions);

  // Every file gets a synthetic module node. It is the parent of top-level
  // definitions and the owner of file-level references (an import call at module
  // scope has to attach to something, or the edge would be dropped).
  const moduleNode = {
    kind: 'module',
    name: path,
    qname: path,
    startLine: 1,
    endLine: countLines(source),
    startByte: 0,
    endByte: source.length,
    signature: null,
    doc: pack.moduleDoc?.(source) ?? null,
    visibility: null,
    isExported: 1,
    tok: estimate(source),
    parentIndex: null,
    depth: 0,
  };

  const nodes = [moduleNode];
  const stack = [{ node: moduleNode, index: 0 }];

  for (const def of definitions) {
    // Pop until the top of the stack actually contains this definition.
    while (stack.length > 1 && stack.at(-1).node.endByte <= def.startByte) stack.pop();

    const parent = stack.at(-1);
    const name = def.name ?? '(anonymous)';
    const kind = normalizeKind(def.suffix);

    const node = {
      kind,
      name,
      qname: buildQName(parent.node, name, kind, path),
      startLine: def.startLine,
      endLine: def.endLine,
      startByte: def.startByte,
      endByte: def.endByte,
      signature: pack.signature?.(def, source) ?? genericSignature(def, source),
      doc: pack.docComment?.(def, source) ?? genericDocComment(def, source),
      visibility: pack.visibility?.(def, source) ?? genericVisibility(name),
      isExported: pack.isExported?.(def, source) ? 1 : 0,
      tok: estimate(source.slice(def.startByte, def.endByte)),
      parentIndex: parent.index,
      depth: parent.node.depth + 1,
    };

    nodes.push(node);
    stack.push({ node, index: nodes.length - 1 });
  }

  // Attach each reference to the innermost definition containing it. A second
  // sweep is needed because references were sorted separately.
  const refs = [];
  let cursor = 0;
  const open = [{ node: moduleNode, index: 0 }];

  for (const ref of references) {
    while (cursor < nodes.length - 1) {
      const candidate = nodes[cursor + 1];
      if (candidate.startByte > ref.startByte) break;
      cursor++;
      while (open.length > 1 && open.at(-1).node.endByte <= candidate.startByte) open.pop();
      open.push({ node: candidate, index: cursor });
    }
    while (open.length > 1 && open.at(-1).node.endByte <= ref.startByte) open.pop();

    refs.push({
      fromIndex: open.at(-1).index,
      name: ref.name ?? ref.text,
      kind: normalizeKind(ref.suffix),
      line: ref.startLine,
      // Kept so a resolver can distinguish `foo()` from `obj.foo()` — the
      // receiver is most of what makes cross-file resolution tractable.
      receiver: ref.receiver ?? null,
      text: ref.text,
    });
  }

  const imports = extractImports({ captures, pack, source });

  return { nodes, refs, imports };
}

/**
 * Collapse definitions that describe the same construct.
 *
 * Query files legitimately overlap: Go declares a struct with both a specific
 * pattern (`type X struct` -> class) and a general one (`type X` -> type), and
 * both fire. Left in, the outline lists `User` twice with different kinds and
 * the symbol table gains a phantom entry that resolution can pick.
 *
 * Kind precedence decides the winner, so the more informative classification
 * survives regardless of the order patterns appear in the file. Mutates in
 * place, since the caller has already sorted.
 */
function dedupeDefinitions(definitions) {
  const KIND_RANK = {
    class: 10, interface: 10, enum: 10, function: 9, method: 9,
    field: 5, const: 4, var: 3, module: 2, type: 1,
  };

  const bestByRange = new Map();
  for (const def of definitions) {
    const key = `${def.startByte}:${def.endByte}:${def.name ?? ''}`;
    const existing = bestByRange.get(key);
    if (!existing) { bestByRange.set(key, def); continue; }
    const rank = (d) => KIND_RANK[normalizeKind(d.suffix)] ?? 0;
    if (rank(def) > rank(existing)) bestByRange.set(key, def);
  }

  if (bestByRange.size === definitions.length) return;

  const keep = new Set(bestByRange.values());
  let write = 0;
  for (let read = 0; read < definitions.length; read++) {
    if (keep.has(definitions[read])) definitions[write++] = definitions[read];
  }
  definitions.length = write;
}

/**
 * Turn a match into a definition/reference record, or null if it is neither.
 * A match carries one role capture plus an optional `@name`.
 */
function classify(match) {
  let role = null;
  let suffix = null;
  let anchor = null;
  let name = null;
  let receiver = null;

  for (const cap of match.captures) {
    if (cap.name === 'name') {
      name = cap.text;
    } else if (cap.name === 'receiver') {
      receiver = cap.text;
    } else if (cap.name.startsWith(DEF_PREFIX)) {
      role = 'definition';
      suffix = cap.name.slice(DEF_PREFIX.length);
      anchor = cap;
    } else if (cap.name.startsWith(REF_PREFIX)) {
      role = 'reference';
      suffix = cap.name.slice(REF_PREFIX.length);
      anchor = cap;
    }
  }

  if (!role || !anchor) return null;

  return {
    role,
    suffix,
    name,
    receiver,
    text: anchor.text,
    type: anchor.type,
    startByte: anchor.startByte,
    endByte: anchor.endByte,
    startLine: anchor.startLine,
    endLine: anchor.endLine,
    startCol: anchor.startCol,
  };
}

/**
 * Qualified name: `src/auth/login.ts::LoginService#login`.
 *
 * `#` before a member and `.` between namespaces mirrors the convention most
 * languages' own docs use, which makes qnames readable to both the agent and a
 * human skimming output.
 */
function buildQName(parent, name, kind, path) {
  if (!parent || parent.kind === 'module') return `${path}::${name}`;
  const sep = kind === 'method' || kind === 'field' ? '#' : '.';
  return `${parent.qname}${sep}${name}`;
}

/**
 * Generic signature: the definition's first line, cleaned up.
 *
 * Good enough to be genuinely useful for every one of the 36 grammars without
 * any per-language work, which is what makes the generic pack a real floor
 * rather than a placeholder. Deep packs override it with something exact.
 */
function genericSignature(def, source) {
  const text = source.slice(def.startByte, Math.min(def.endByte, def.startByte + 400));
  const firstLine = text.split('\n')[0].trim();
  return firstLine
    .replace(/\s*[{:]\s*$/, '')   // trailing brace or colon adds nothing
    .replace(/\s+/g, ' ')
    .slice(0, 200) || null;
}

/**
 * Generic doc comment: contiguous comment lines immediately above the
 * definition. Recognises `//`, `#`, `--`, `;` and block comments, which covers
 * essentially every language in the grammar set.
 */
function genericDocComment(def, source) {
  const before = source.slice(0, def.startByte);
  const lines = before.split('\n');
  lines.pop(); // partial line the definition starts on

  const collected = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) {
      // A blank line ends the block, unless nothing has been collected yet
      // (handles a blank line between a decorator and its comment).
      if (collected.length) break;
      continue;
    }
    if (/^(\/\/|#|--|;|\*|\/\*)/.test(line)) {
      collected.unshift(stripCommentMarkers(line));
      continue;
    }
    if (line.endsWith('*/')) {
      collected.unshift(stripCommentMarkers(line));
      continue;
    }
    break;
  }

  // Doc tags (@param, @returns, @throws, @author) are structure the agent can
  // re-derive from the signature. The prose summary is the part worth tokens.
  // This convention holds across JSDoc, JavaDoc, PHPDoc and KDoc.
  const prose = [];
  for (const line of collected) {
    if (/^@\w+/.test(line)) break;
    prose.push(line);
  }

  const doc = prose.join(' ').replace(/\s+/g, ' ').trim();
  return doc ? doc.slice(0, 500) : null;
}

function stripCommentMarkers(line) {
  return line
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .replace(/^(\/\/+|#+|--+|;+|\*+)\s?/, '')
    .trim();
}

/** Leading underscore is the near-universal convention for "not public". */
function genericVisibility(name) {
  return name.startsWith('_') ? 'private' : null;
}

function extractImports({ captures, pack, source }) {
  const out = [];
  for (const match of captures.imports ?? []) {
    const parsed = pack.parseImport?.(match, source) ?? genericImport(match);
    if (!parsed) continue;
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (item?.spec) out.push(item);
    }
  }
  return dedupeImports(out);
}

/**
 * Collapse duplicate rows for the same import statement.
 *
 * Import queries deliberately overlap: a specific pattern captures the bound
 * names, and a catch-all captures the specifier so that side-effect imports
 * (`import 'polyfill'`) are not missed. Both fire on a normal import, producing
 * a real row plus a bare `{spec, null, null}` row for the same line.
 *
 * Left in, those bare rows inflate dependency use counts and make a named import
 * look like a namespace import during resolution. So: for any (spec, line), a
 * bare row survives only if nothing more specific was found.
 */
function dedupeImports(imports) {
  const seen = new Set();
  const specific = new Set();
  const out = [];

  for (const imp of imports) {
    if (imp.symbol || imp.alias) specific.add(`${imp.spec} ${imp.line}`);
  }

  for (const imp of imports) {
    const group = `${imp.spec} ${imp.line}`;
    if (!imp.symbol && !imp.alias && specific.has(group)) continue;

    const key = `${group} ${imp.symbol ?? ''} ${imp.alias ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(imp);
  }

  return out;
}

/** Generic import: whatever the pack captured as `@source`, unquoted. */
function genericImport(match) {
  const source = match.captures.find((c) => c.name === 'source');
  if (!source) return null;
  const symbol = match.captures.find((c) => c.name === 'symbol');
  const alias = match.captures.find((c) => c.name === 'alias');
  return {
    spec: unquote(source.text),
    symbol: symbol ? symbol.text : null,
    alias: alias ? alias.text : (symbol ? symbol.text : null),
    line: source.startLine,
  };
}

function unquote(s) {
  return s.replace(/^['"`]|['"`]$/g, '');
}

function countLines(text) {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
