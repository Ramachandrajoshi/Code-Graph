/**
 * Go language pack.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import builtins from './builtins.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  id: 'go',
  languages: ['go'],

  queries: {
    tags: path.join(here, 'queries', 'tags.scm'),
    imports: path.join(here, 'queries', 'imports.scm'),
  },

  builtins,

  detect(ctx) {
    return ctx.hasFile('go.mod') || ctx.hasFile('go.sum');
  },

  /** Header up to the body brace, so multi-line parameter lists survive. */
  signature(def, source) {
    const text = source.slice(def.startByte, def.endByte);
    const brace = findBodyBrace(text);
    return (brace === -1 ? text.split('\n')[0] : text.slice(0, brace))
      .replace(/\s+/g, ' ')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .trim()
      .slice(0, 300) || null;
  },

  /** Go doc comments are `//` lines immediately above, conventionally starting with the name. */
  docComment(def, source) {
    const lines = source.slice(0, def.startByte).split('\n');
    lines.pop();

    const collected = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith('//')) break;
      collected.unshift(line.replace(/^\/\/\s?/, ''));
    }
    const doc = collected.join(' ').replace(/\s+/g, ' ').trim();
    return doc ? doc.slice(0, 500) : null;
  },

  /**
   * Go's visibility rule is purely lexical: an identifier is exported if and
   * only if it starts with an upper-case letter. No keyword involved.
   */
  isExported(def, source) {
    const name = source.slice(def.startByte, def.endByte)
      .match(/(?:func|type|const|var)\s+(?:\([^)]*\)\s*)?(\w+)/)?.[1];
    return name ? /^[A-Z]/.test(name) : false;
  },

  visibility(def, source) {
    return this.isExported(def, source) ? 'public' : 'private';
  },

  /**
   * Resolve an import path to a directory of Go files.
   *
   * Go packages are directories, not files, so a specifier resolves to whichever
   * indexed file lives in the matching directory. The module path from go.mod is
   * stripped first: `github.com/org/proj/internal/db` is `internal/db` on disk.
   */
  resolveImport(spec, fromPath, ctx) {
    const modulePath = readModulePath(ctx);

    if (modulePath && spec.startsWith(modulePath)) {
      const rel = spec.slice(modulePath.length).replace(/^\//, '');
      const hit = firstFileInDir(ctx, rel);
      if (hit) return { file: hit };
    }

    // A specifier with no dot in its first segment is stdlib ("fmt", "net/http").
    const firstSegment = spec.split('/')[0];
    if (!firstSegment.includes('.')) {
      return { external: { ecosystem: 'go-stdlib', package: spec } };
    }

    // Third-party module paths are host/org/repo; deeper segments are packages
    // within the same module and should not each count as a dependency.
    return { external: { ecosystem: 'go', package: spec.split('/').slice(0, 3).join('/') } };
  },

  parseImport(match) {
    const source = match.captures.find((c) => c.name === 'source');
    if (!source) return null;
    const alias = match.captures.find((c) => c.name === 'alias');
    const spec = source.text.replace(/^"|"$/g, '');
    return {
      spec,
      symbol: null,
      // Without an explicit alias, the binding is the last path segment.
      alias: alias?.text ?? spec.split('/').pop(),
      line: source.startLine,
    };
  },
};

/** Cache: go.mod is read once per index, not once per import. */
let moduleCache = null;

function readModulePath(ctx) {
  if (moduleCache && moduleCache.root === ctx.root) return moduleCache.path;
  let modulePath = null;
  try {
    const text = fs.readFileSync(path.join(ctx.root, 'go.mod'), 'utf8');
    modulePath = text.match(/^\s*module\s+(\S+)/m)?.[1] ?? null;
  } catch {
    // No go.mod: every import is treated as external, which is correct for a
    // loose collection of Go files.
  }
  moduleCache = { root: ctx.root, path: modulePath };
  return modulePath;
}

/**
 * Any indexed .go file directly inside `dir`.
 * A Go package is a directory, so any file in it is a valid resolution target.
 */
function firstFileInDir(ctx, dir) {
  const prefix = dir ? `${dir}/` : '';
  for (const p of ctx.allPaths()) {
    if (!p.startsWith(prefix) || !p.endsWith('.go')) continue;
    if (p.slice(prefix.length).includes('/')) continue; // must be direct child
    if (p.endsWith('_test.go')) continue;
    return p;
  }
  return null;
}

function findBodyBrace(text) {
  let paren = 0, bracket = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '[') bracket++;
    else if (c === ']') bracket--;
    else if (c === '{' && paren === 0 && bracket === 0) return i;
  }
  return -1;
}
