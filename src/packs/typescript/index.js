/**
 * TypeScript / TSX language pack.
 *
 * A "deep" pack: it supplies exact signatures, JSDoc extraction, export
 * detection and (in P2) module resolution, on top of the shared extraction
 * machinery. Everything here is optional from core's perspective — remove any
 * hook and the generic fallback takes over with lower fidelity.
 */

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { tryCandidates, normalizeRelative } from '../../core/resolve.js';
import builtins from './builtins.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Candidate suffixes for an extensionless specifier, in Node's own precedence
 * order. `.ts` precedes `.js` because in a TypeScript project the compiled
 * output frequently sits beside the source, and the source is what an agent
 * wants to be shown.
 */
const EXTENSIONS = [
  '', '.ts', '.tsx', '.mts', '.cts', '.d.ts',
  '.js', '.jsx', '.mjs', '.cjs',
];

export default {
  id: 'typescript',
  // TSX uses a different grammar but shares every node type this pack's queries
  // name, so one pack serves both. JavaScript does NOT — it needs its own tags
  // query and has its own pack.
  languages: ['typescript', 'tsx'],

  queries: {
    tags: path.join(here, 'queries', 'tags.scm'),
    imports: path.join(here, 'queries', 'imports.scm'),
  },

  builtins,

  /**
   * Optional precision upgrade, used only when explicitly requested.
   *
   * Never started during indexing: warming a TypeScript server on a large repo
   * takes tens of seconds and gigabytes, which would destroy the fast-index
   * property everything else depends on. Consulted on demand by
   * `cgraph graph --upgrade`, and the proven results are cached in the graph.
   */
  lsp: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    capabilities: ['definition', 'references', 'hover'],
  },

  /** Relevance signal used to decide whether to load this pack at all. */
  detect(ctx) {
    return ctx.hasFile('tsconfig.json') || ctx.hasFile('package.json');
  },

  /**
   * Exact signature: everything from the start of the definition up to the body.
   *
   * The generic fallback takes the first physical line, which truncates
   * multi-line parameter lists — extremely common in TypeScript, and precisely
   * the code where an agent most needs the parameter types.
   */
  signature(def, source) {
    const text = source.slice(def.startByte, def.endByte);
    const end = findBodyStart(text);
    let sig = (end === -1 ? text : text.slice(0, end)).trim();

    sig = sig
      .replace(/\s*=>\s*$/, '')
      .replace(/[{=;]\s*$/, '')
      .replace(/\s+/g, ' ')
      // Collapsing a wrapped parameter list leaves artifacts of the original
      // line breaks: `login( email: string, pw: string, )`. Normalize them so
      // the signature reads the way it would if it had been written on one line.
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .replace(/,\s*\)/g, ')')
      .replace(/\s+,/g, ',')
      .replace(/<\s+/g, '<')
      .replace(/\s+>/g, '>')
      .trim();

    // Drop a leading JSDoc block that the node range happens to include.
    sig = sig.replace(/^\/\*\*[\s\S]*?\*\/\s*/, '');

    return sig.slice(0, 300) || null;
  },

  /** JSDoc immediately preceding the definition, markers stripped. */
  docComment(def, source) {
    const before = source.slice(0, def.startByte);
    // The definition node starts at `function`/`class`, so any modifiers written
    // before it sit between the JSDoc and the node. Skipping them is what keeps
    // `export function` from falling through to the generic extractor, which
    // does not understand doc tags.
    const trimmed = before
      .replace(/\s*$/, '')
      .replace(/(\s|^)(export|default|declare|abstract|async|static|public|private|protected|readonly)+$/g, '')
      .replace(/\s*$/, '');
    if (!trimmed.endsWith('*/')) return null;

    const open = trimmed.lastIndexOf('/**');
    if (open === -1) return null;

    const block = trimmed.slice(open + 3, trimmed.length - 2);
    const text = block
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, '').trim())
      // Tag lines are structure, not prose; the summary is what an agent scans.
      .filter((l) => l && !l.startsWith('@'))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    return text ? text.slice(0, 500) : null;
  },

  isExported(def, source) {
    // Walk back over whitespace and decorators to find an `export` keyword.
    const before = source.slice(Math.max(0, def.startByte - 400), def.startByte);
    return /\bexport\s+(default\s+)?(abstract\s+|async\s+|declare\s+)*$/.test(before);
  },

  visibility(def, source) {
    const text = source.slice(def.startByte, def.startByte + 80);
    if (/^\s*(private|#)/.test(text)) return 'private';
    if (/^\s*protected\b/.test(text)) return 'protected';
    if (/^\s*public\b/.test(text)) return 'public';
    return null;
  },

  /** Leading `/** ... *\/` block at the top of the file. */
  moduleDoc(source) {
    const m = source.match(/^\s*\/\*\*([\s\S]*?)\*\//);
    if (!m) return null;
    return m[1]
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, '').trim())
      .filter((l) => l && !l.startsWith('@'))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500) || null;
  },

  /**
   * Resolve a module specifier to a repo file, or classify it as external.
   *
   * This implements the subset of Node/TypeScript resolution that matters for a
   * source index: relative paths with implicit extensions and directory
   * indexes, plus tsconfig `paths` aliases. It deliberately does NOT walk
   * node_modules to resolve bare specifiers — those are dependencies, and the
   * dependency-docs subsystem handles them far more usefully than pretending
   * `express` is a file in the repo.
   */
  resolveImport(spec, fromPath, ctx) {
    if (spec.startsWith('.')) {
      const base = normalizeRelative(fromPath, spec);
      const hit = tryCandidates(ctx, base, EXTENSIONS) ?? tryCandidates(ctx, base + '/index', EXTENSIONS);
      return hit ? { file: hit } : null;
    }

    // tsconfig path aliases: '@app/foo' -> 'src/foo'
    for (const base of resolveAlias(spec, ctx)) {
      const hit = tryCandidates(ctx, base, EXTENSIONS) ?? tryCandidates(ctx, base + '/index', EXTENSIONS);
      if (hit) return { file: hit };
    }

    // Bare specifier. Scoped packages keep both segments ('@scope/pkg'), and a
    // deep import ('lodash/fp') is credited to its package.
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (!pkg || spec.startsWith('node:')) {
      return { external: { ecosystem: 'node', package: spec.replace(/^node:/, '') } };
    }
    return { external: { ecosystem: 'npm', package: pkg } };
  },

  /**
   * One import statement can bind several names, and each binding is a separate
   * row — `import { a, b }` must produce two, or resolving `b` later fails.
   */
  parseImport(match) {
    const cap = (n) => match.captures.filter((c) => c.name === n);
    const source = cap('source')[0];
    if (!source) return null;

    const spec = source.text.replace(/^['"`]|['"`]$/g, '');
    const symbols = cap('symbol');
    const aliases = cap('alias');
    const line = source.startLine;

    if (!symbols.length && !aliases.length) {
      return { spec, symbol: null, alias: null, line };
    }

    const out = [];
    for (let i = 0; i < symbols.length; i++) {
      out.push({
        spec,
        symbol: symbols[i].text,
        alias: aliases[i]?.text ?? symbols[i].text,
        line,
      });
    }
    // A default or namespace import has an alias but no named symbol.
    for (let i = symbols.length; i < aliases.length; i++) {
      out.push({ spec, symbol: null, alias: aliases[i].text, line });
    }
    return out;
  },
};

/**
 * tsconfig `paths` aliases, read once per process.
 *
 * Path aliases are extremely common in real TypeScript projects and every
 * aliased import is a cross-file edge. Without this, a repo using `@/components`
 * throughout would have essentially no EXACT internal edges — the graph would
 * technically work while being useless.
 */
let aliasCache = null;

function loadAliases(ctx) {
  if (aliasCache && aliasCache.root === ctx.root) return aliasCache.entries;

  const entries = [];
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(ctx.root, name);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    let config;
    try {
      config = JSON.parse(stripJsonComments(raw));
    } catch {
      // tsconfig files tolerate trailing commas and comments that JSON does not.
      // A malformed one is not worth failing the whole index over.
      continue;
    }

    const opts = config.compilerOptions ?? {};
    const baseUrl = (opts.baseUrl ?? '.').replace(/\\/g, '/').replace(/^\.\//, '');
    const prefix = baseUrl === '.' || baseUrl === '' ? '' : baseUrl.replace(/\/$/, '') + '/';

    for (const [pattern, targets] of Object.entries(opts.paths ?? {})) {
      if (!Array.isArray(targets) || !targets.length) continue;
      entries.push({
        prefix: pattern.replace(/\*$/, ''),
        wildcard: pattern.endsWith('*'),
        targets: targets.map((t) => prefix + t.replace(/\*$/, '').replace(/^\.\//, '')),
      });
    }
  }

  // Longest prefix first, so '@app/models' beats '@app/' when both are defined.
  entries.sort((a, b) => b.prefix.length - a.prefix.length);
  aliasCache = { root: ctx.root, entries };
  return entries;
}

/**
 * Candidate base paths for an aliased specifier.
 *
 * A tsconfig alias may list several targets and each is tried in order, so this
 * returns all of them rather than picking one — only the caller knows which
 * extensions make a candidate real.
 */
function resolveAlias(spec, ctx) {
  const out = [];
  for (const entry of loadAliases(ctx)) {
    if (entry.wildcard ? spec.startsWith(entry.prefix) : spec === entry.prefix) {
      const rest = spec.slice(entry.prefix.length);
      for (const target of entry.targets) {
        out.push((target + rest).replace(/\/+/g, '/'));
      }
    }
  }
  return out;
}

/** Strip // and /* *\/ comments, which tsconfig permits and JSON.parse does not. */
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];

    if (inLine) { if (c === '\n') { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (inString) {
      out += c;
      if (c === '\\') { out += next ?? ''; i++; }
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    out += c;
  }

  // Trailing commas are also legal in tsconfig but not in JSON.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Index of the character that begins a definition's body.
 *
 * Scanning for the first top-level `{` is not enough: object type annotations
 * (`function f(opts: { a: number })`) and generic constraints both contain
 * braces that are part of the signature. Tracking nesting across (), [], <> and
 * skipping strings is what keeps those intact.
 */
function findBodyStart(text) {
  let paren = 0, bracket = 0, angle = 0;
  let quote = null;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }

    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '[') bracket++;
    else if (c === ']') bracket--;
    else if (c === '<') angle++;
    else if (c === '>') angle = Math.max(0, angle - 1);
    else if (c === '{' && paren === 0 && bracket === 0 && angle === 0) return i;
    else if (c === ';' && paren === 0 && bracket === 0) return i;
    else if (c === '=' && text[i + 1] === '>' && paren === 0 && angle === 0) return i;
  }
  return -1;
}
