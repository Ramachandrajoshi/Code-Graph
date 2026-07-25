/**
 * Rust language pack.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import builtins from './builtins.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  id: 'rust',
  languages: ['rust'],

  queries: {
    tags: path.join(here, 'queries', 'tags.scm'),
    imports: path.join(here, 'queries', 'imports.scm'),
  },

  builtins,

  detect(ctx) {
    return ctx.hasFile('Cargo.toml');
  },

  signature(def, source) {
    const text = source.slice(def.startByte, def.endByte);
    const end = findSignatureEnd(text);
    return (end === -1 ? text.split('\n')[0] : text.slice(0, end))
      .replace(/\s+/g, ' ')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .replace(/<\s+/g, '<')
      .trim()
      .slice(0, 300) || null;
  },

  /**
   * Rust doc comments are `///` (outer) or `//!` (inner). Plain `//` is an
   * ordinary comment and is deliberately excluded — including it would fill the
   * index with implementation asides rather than API documentation.
   */
  docComment(def, source) {
    const lines = source.slice(0, def.startByte).split('\n');
    lines.pop();

    const collected = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('#[')) continue;              // attributes sit between doc and item
      if (!line.startsWith('///') && !line.startsWith('//!')) break;
      collected.unshift(line.replace(/^\/\/[/!]\s?/, ''));
    }
    const doc = collected.join(' ').replace(/\s+/g, ' ').trim();
    return doc ? doc.slice(0, 500) : null;
  },

  isExported(def, source) {
    return /^\s*pub\b/.test(source.slice(def.startByte, def.startByte + 40));
  },

  visibility(def, source) {
    const head = source.slice(def.startByte, def.startByte + 40);
    if (/^\s*pub\s*\(\s*crate\s*\)/.test(head)) return 'internal';
    if (/^\s*pub\b/.test(head)) return 'public';
    return 'private';
  },

  /**
   * Resolve a `use` path or `mod` declaration.
   *
   * `crate::` and `self::` are internal; a bare first segment is either a local
   * module or an external crate, decided by whether a matching file exists.
   */
  resolveImport(spec, fromPath, ctx) {
    const segments = String(spec).split('::').map((s) => s.trim()).filter(Boolean);
    if (!segments.length) return null;

    const head = segments[0];

    if (head === 'crate' || head === 'self' || head === 'super') {
      const srcRoot = fromPath.startsWith('src/') ? 'src' : path.posix.dirname(fromPath);
      const rest = segments.slice(1);
      const base = head === 'crate' ? ['src', ...rest] : [srcRoot, ...rest];
      return matchModule(ctx, base.join('/')) ?? null;
    }

    // A local module declared with `mod name;`
    const local = matchModule(ctx, path.posix.join(path.posix.dirname(fromPath), head))
      ?? matchModule(ctx, `src/${head}`);
    if (local) return local;

    if (head === 'std' || head === 'core' || head === 'alloc') {
      return { external: { ecosystem: 'rust-std', package: head } };
    }
    return { external: { ecosystem: 'cargo', package: head } };
  },

  parseImport(match) {
    const cap = (n) => match.captures.filter((c) => c.name === n);
    const source = cap('source')[0];
    if (!source) return null;

    const spec = source.text;
    const symbols = cap('symbol');
    const aliases = cap('alias');
    const line = source.startLine;

    if (!symbols.length) {
      return { spec, symbol: null, alias: aliases[0]?.text ?? spec.split('::').pop(), line };
    }
    return symbols.map((s, i) => ({
      spec, symbol: s.text, alias: aliases[i]?.text ?? s.text, line,
    }));
  },
};

/** `foo` resolves to foo.rs, foo/mod.rs, or (2018 edition) the directory itself. */
function matchModule(ctx, base) {
  if (!base) return null;
  const clean = base.replace(/\/+/g, '/').replace(/^\//, '');
  for (const candidate of [`${clean}.rs`, `${clean}/mod.rs`, `${clean}/lib.rs`]) {
    if (ctx.hasFile(candidate)) return { file: candidate };
  }
  // Trailing segment may be an item inside the module rather than a module.
  const cut = clean.lastIndexOf('/');
  if (cut > 0) {
    const parent = clean.slice(0, cut);
    for (const candidate of [`${parent}.rs`, `${parent}/mod.rs`]) {
      if (ctx.hasFile(candidate)) return { file: candidate };
    }
  }
  return null;
}

/** End of a signature: the body brace, or `;` for a trait method with no body. */
function findSignatureEnd(text) {
  let paren = 0, angle = 0, bracket = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '<') angle++;
    else if (c === '>') angle = Math.max(0, angle - 1);
    else if (c === '[') bracket++;
    else if (c === ']') bracket--;
    else if ((c === '{' || c === ';') && paren === 0 && angle === 0 && bracket === 0) return i;
  }
  return -1;
}
