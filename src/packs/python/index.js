/**
 * Python language pack.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import builtins from './builtins.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export default {
  id: 'python',
  languages: ['python'],

  queries: {
    tags: path.join(here, 'queries', 'tags.scm'),
    imports: path.join(here, 'queries', 'imports.scm'),
  },

  builtins,

  detect(ctx) {
    return (
      ctx.hasFile('pyproject.toml') ||
      ctx.hasFile('setup.py') ||
      ctx.hasFile('requirements.txt') ||
      ctx.hasFile('setup.cfg') ||
      ctx.hasFile('Pipfile')
    );
  },

  /**
   * Signature: the `def`/`class` header up to its colon.
   *
   * Python signatures routinely wrap across many lines once type hints are
   * involved, so taking the first physical line (the generic fallback) would
   * drop most of the parameters.
   */
  signature(def, source) {
    const text = source.slice(def.startByte, def.endByte);
    const end = findHeaderEnd(text);
    let sig = (end === -1 ? text.split('\n')[0] : text.slice(0, end)).trim();

    // A decorated definition's range starts at the decorator; the signature the
    // agent wants is the def line, but the decorators are worth keeping since
    // they change behavior (@property, @staticmethod, @app.route).
    sig = sig.replace(/\s+/g, ' ').trim();
    return sig.slice(0, 300) || null;
  },

  /**
   * Docstring: the first string literal in the body.
   *
   * Python puts documentation *inside* the definition, unlike every
   * comment-above language, so the generic extractor finds nothing here.
   */
  docComment(def, source) {
    const text = source.slice(def.startByte, def.endByte);
    const colon = findHeaderEnd(text);
    if (colon === -1) return null;

    const body = text.slice(colon + 1);
    const m = body.match(/^\s*(?:[rRbBuUfF]{0,2})("""|'''|"|')/);
    if (!m) return null;

    const quote = m[1];
    const start = body.indexOf(quote, m.index) + quote.length;
    const end = body.indexOf(quote, start);
    if (end === -1) return null;

    return body
      .slice(start, end)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 500) || null;
  },

  /** Module docstring: same rule applied to the whole file. */
  moduleDoc(source) {
    const m = source.match(/^\s*(?:[rRbBuUfF]{0,2})("""|''')([\s\S]*?)\1/);
    if (!m) return null;
    return m[2].split('\n').map((l) => l.trim()).filter(Boolean).join(' ')
      .replace(/\s+/g, ' ').trim().slice(0, 500) || null;
  },

  /**
   * Python has no export keyword. A name is public unless it starts with an
   * underscore, or `__all__` says otherwise — the underscore convention is what
   * every tool and every reader actually uses.
   */
  isExported(def, source) {
    const name = source.slice(def.startByte, def.endByte).match(/(?:def|class)\s+(\w+)/)?.[1];
    return name ? !name.startsWith('_') : true;
  },

  visibility(def, source) {
    const name = source.slice(def.startByte, def.endByte).match(/(?:def|class)\s+(\w+)/)?.[1];
    if (!name) return null;
    // Dunder methods are protocol, not private API.
    if (name.startsWith('__') && name.endsWith('__')) return 'public';
    if (name.startsWith('__')) return 'private';
    if (name.startsWith('_')) return 'protected';
    return 'public';
  },

  /**
   * Resolve a Python module specifier to a repo file.
   *
   * Handles the two forms that carry real structure:
   *   - relative (`from . import x`, `from ..pkg.mod import y`), where the
   *     number of leading dots sets how far up the package tree to walk
   *   - absolute (`from app.services import x`), tried against the repo root
   *     and the common source roots
   *
   * A module that resolves to neither is treated as a third-party dependency.
   * Standard-library modules are recognised explicitly so `os` and `json` are
   * not reported as missing PyPI packages.
   */
  resolveImport(spec, fromPath, ctx) {
    if (spec.startsWith('.')) {
      const dots = spec.match(/^\.+/)[0].length;
      const rest = spec.slice(dots).replace(/^\./, '');

      // One dot means "this package" (the file's own directory), so the first
      // dot consumes the filename and each additional dot goes up a level.
      const parts = fromPath.split('/');
      parts.pop();
      for (let i = 1; i < dots; i++) parts.pop();

      const base = [...parts, ...(rest ? rest.split('.') : [])].join('/');
      return matchModule(ctx, base) ?? null;
    }

    const segments = spec.split('.');
    if (STDLIB.has(segments[0])) {
      return { external: { ecosystem: 'python-stdlib', package: segments[0] } };
    }

    for (const root of ['', 'src/', 'lib/', 'app/']) {
      const hit = matchModule(ctx, root + segments.join('/'));
      if (hit) return hit;
    }

    return { external: { ecosystem: 'pypi', package: segments[0] } };
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
      // `import os.path as p` binds the alias, or the leading segment if none.
      return { spec, symbol: null, alias: aliases[0]?.text ?? spec.split('.')[0], line };
    }

    return symbols.map((s, i) => ({
      spec,
      symbol: s.text,
      alias: aliases[i]?.text ?? s.text,
      line,
    }));
  },
};

/**
 * A dotted module path can name a module file or a package directory, and the
 * last segment may be a symbol inside the module rather than part of the path
 * (`from app.models import User` vs `import app.models.user`). Both shapes are
 * tried before giving up.
 */
function matchModule(ctx, base) {
  if (!base) return null;
  if (ctx.hasFile(`${base}.py`)) return { file: `${base}.py` };
  if (ctx.hasFile(`${base}/__init__.py`)) return { file: `${base}/__init__.py` };
  if (ctx.hasFile(`${base}.pyi`)) return { file: `${base}.pyi` };

  // Trailing segment may be a symbol, not a module.
  const cut = base.lastIndexOf('/');
  if (cut > 0) {
    const parent = base.slice(0, cut);
    if (ctx.hasFile(`${parent}.py`)) return { file: `${parent}.py` };
    if (ctx.hasFile(`${parent}/__init__.py`)) return { file: `${parent}/__init__.py` };
  }
  return null;
}

/**
 * Standard-library top-level modules.
 *
 * Without this list every `import os` would be recorded as a missing PyPI
 * package, burying real dependencies in noise in the docs output.
 */
const STDLIB = new Set([
  'abc', 'argparse', 'ast', 'asyncio', 'base64', 'bisect', 'builtins', 'bz2',
  'calendar', 'collections', 'concurrent', 'configparser', 'contextlib', 'copy',
  'csv', 'ctypes', 'dataclasses', 'datetime', 'decimal', 'difflib', 'dis',
  'email', 'enum', 'errno', 'faulthandler', 'fcntl', 'filecmp', 'fileinput',
  'fnmatch', 'fractions', 'functools', 'gc', 'getpass', 'glob', 'gzip', 'hashlib',
  'heapq', 'hmac', 'html', 'http', 'imaplib', 'importlib', 'inspect', 'io',
  'ipaddress', 'itertools', 'json', 'keyword', 'linecache', 'locale', 'logging',
  'lzma', 'math', 'mimetypes', 'multiprocessing', 'numbers', 'operator', 'os',
  'pathlib', 'pickle', 'platform', 'pprint', 'queue', 'random', 're', 'select',
  'shlex', 'shutil', 'signal', 'site', 'socket', 'sqlite3', 'ssl', 'stat',
  'string', 'struct', 'subprocess', 'sys', 'tarfile', 'tempfile', 'textwrap',
  'threading', 'time', 'timeit', 'token', 'tokenize', 'traceback', 'types',
  'typing', 'unicodedata', 'unittest', 'urllib', 'uuid', 'venv', 'warnings',
  'weakref', 'webbrowser', 'xml', 'zipfile', 'zlib',
]);

/**
 * Index of the colon ending a `def`/`class` header.
 * Skips colons inside brackets (dict defaults, subscripted type hints) and
 * strings, both of which appear constantly in annotated signatures.
 */
function findHeaderEnd(text) {
  let paren = 0, bracket = 0, brace = 0;
  let quote = null;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }

    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#') { // comment runs to end of line
      const nl = text.indexOf('\n', i);
      if (nl === -1) return -1;
      i = nl;
      continue;
    }
    if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '[') bracket++;
    else if (c === ']') bracket--;
    else if (c === '{') brace++;
    else if (c === '}') brace--;
    else if (c === ':' && paren === 0 && bracket === 0 && brace === 0) return i;
  }
  return -1;
}
