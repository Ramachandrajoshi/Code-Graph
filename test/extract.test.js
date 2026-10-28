/**
 * Extraction tests: captures -> hierarchy, signatures, docs, refs, imports.
 *
 * These run the real grammars rather than mocking captures, because the bugs
 * that actually happen here live in the .scm files, not in the JS.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PackRegistry } from '../src/packs/registry.js';
import { DEFAULTS } from '../src/core/config.js';
import { extract } from '../src/core/extract.js';

const require = createRequire(import.meta.url);
const haveBundled = (() => {
  try { require.resolve('tree-sitter-wasms/package.json'); return true; }
  catch { return false; }
})();

let registry;
async function reg() {
  if (!registry) {
    registry = await PackRegistry.load({
      ...DEFAULTS,
      root: process.cwd(),
      dir: process.cwd() + '/.cgraph',
      deps: { ...DEFAULTS.deps, offline: true },
    });
  }
  return registry;
}

async function parse(rel, content) {
  const r = await reg();
  const lang = r.detect(rel, content);
  assert.ok(lang, `no language detected for ${rel}`);
  const [res] = await r.parseBatch([{ file: { rel, content }, lang, tok: 0 }]);
  assert.equal(res.error, null, `parse error: ${res.error}`);
  assert.ok(res.extraction, `no extraction (skipped: ${res.skipped})`);
  return res.extraction;
}

const opts = { skip: !haveBundled };

test('builds a class -> method hierarchy', opts, async () => {
  const { nodes } = await parse('a.ts', `
export class Service {
  run(): void {}
  private helper(): number { return 1; }
}
`);
  const cls = nodes.find((n) => n.name === 'Service');
  const run = nodes.find((n) => n.name === 'run');
  const helper = nodes.find((n) => n.name === 'helper');

  assert.equal(cls.kind, 'class');
  assert.equal(run.kind, 'method');
  assert.equal(nodes[run.parentIndex].name, 'Service');
  assert.equal(nodes[helper.parentIndex].name, 'Service');
  assert.equal(run.depth, 2, 'module -> class -> method');
});

test('top-level constants do not adopt the rest of the file', opts, async () => {
  // Regression guard for a capture placed on (program ...) instead of the
  // declaration: the constant then spans the whole file and every later
  // definition becomes its child. The outline looked plausible but the
  // hierarchy — the thing the whole tool is built on — was wrong.
  const { nodes } = await parse('a.js', `
const LIMIT = 10;

function first() {}
function second() {}
class Later {}
`);
  const limit = nodes.find((n) => n.name === 'LIMIT');
  const first = nodes.find((n) => n.name === 'first');
  const later = nodes.find((n) => n.name === 'Later');

  assert.ok(limit, 'the constant should be extracted');
  assert.equal(nodes[first.parentIndex].kind, 'module', 'function must belong to the module');
  assert.equal(nodes[later.parentIndex].kind, 'module', 'class must belong to the module');
  assert.equal(first.depth, 1);
});

test('every definition range stays inside its parent', opts, async () => {
  const { nodes } = await parse('a.ts', `
const A = 1;
export class Outer {
  method() { const x = 1; }
}
export function after() {}
`);
  for (const n of nodes) {
    if (n.parentIndex === null) continue;
    const p = nodes[n.parentIndex];
    assert.ok(
      n.startByte >= p.startByte && n.endByte <= p.endByte,
      `${n.name} (${n.startByte}-${n.endByte}) escapes parent ${p.name} (${p.startByte}-${p.endByte})`
    );
  }
});

test('captures multi-line TypeScript signatures whole', opts, async () => {
  const { nodes } = await parse('a.ts', `
class S {
  async login(
    email: string,
    pw: string,
  ): Promise<Session> {
    return null;
  }
}
`);
  const login = nodes.find((n) => n.name === 'login');
  // The generic first-physical-line fallback would yield 'async login(' — which
  // omits every parameter type, the most useful part.
  assert.equal(login.signature, 'async login(email: string, pw: string): Promise<Session>');
});

test('extracts JSDoc and drops tag lines', opts, async () => {
  const { nodes } = await parse('a.ts', `
/**
 * Authenticates a user.
 * @param email the address
 * @returns a session
 */
export function login(email: string) {}
`);
  const fn = nodes.find((n) => n.name === 'login');
  assert.equal(fn.doc, 'Authenticates a user.');
});

test('extracts Python docstrings from inside the body', opts, async () => {
  const { nodes } = await parse('a.py', `
def login(email, pw):
    """Authenticate a user.

    Longer explanation here.
    """
    return None
`);
  const fn = nodes.find((n) => n.name === 'login');
  assert.match(fn.doc, /^Authenticate a user\./);
});

test('handles Python signatures with annotated defaults', opts, async () => {
  const { nodes } = await parse('a.py', `
def fetch(url: str, opts: dict = {"a": 1}, timeout: int = 30) -> Response:
    pass
`);
  const fn = nodes.find((n) => n.name === 'fetch');
  // A naive scan for the first ':' stops inside the type hint or the dict.
  assert.match(fn.signature, /-> Response$/);
  assert.match(fn.signature, /timeout: int = 30/);
});

test('attaches references to the enclosing definition', opts, async () => {
  const { nodes, refs } = await parse('a.ts', `
class S {
  outer() { helperOne(); }
  inner() { helperTwo(); }
}
`);
  const one = refs.find((r) => r.name === 'helperOne');
  const two = refs.find((r) => r.name === 'helperTwo');
  assert.equal(nodes[one.fromIndex].name, 'outer');
  assert.equal(nodes[two.fromIndex].name, 'inner');
});

test('captures the receiver of a member call', opts, async () => {
  const { refs } = await parse('a.ts', `
function f() { db.users.find(1); }
`);
  const call = refs.find((r) => r.name === 'find');
  // Without the receiver, `find` is unresolvable: dozens of objects have one.
  assert.equal(call.receiver, 'db.users');
});

test('file-level references attach to the module node', opts, async () => {
  const { nodes, refs } = await parse('a.js', `
setup();
`);
  const ref = refs.find((r) => r.name === 'setup');
  assert.equal(nodes[ref.fromIndex].kind, 'module', 'a top-level call must not be dropped');
});

test('expands named imports into one row per binding', opts, async () => {
  const { imports } = await parse('a.ts', `
import { alpha, beta as b } from './mod';
`);
  const alpha = imports.find((i) => i.symbol === 'alpha');
  const beta = imports.find((i) => i.symbol === 'beta');
  assert.equal(alpha.spec, './mod');
  assert.equal(beta.alias, 'b', 'the local binding name is what resolution needs');
});

test('does not emit duplicate rows for one import statement', opts, async () => {
  // Import queries overlap on purpose so side-effect imports are not missed;
  // the overlap must not survive into the index or it inflates use counts.
  const { imports } = await parse('a.ts', `
import { db } from '../db';
import bcrypt from 'bcrypt';
`);
  const dbRows = imports.filter((i) => i.spec === '../db');
  const bcryptRows = imports.filter((i) => i.spec === 'bcrypt');
  assert.equal(dbRows.length, 1, `expected 1 row for ../db, got ${dbRows.length}`);
  assert.equal(bcryptRows.length, 1);
  assert.equal(bcryptRows[0].alias, 'bcrypt');
});

test('keeps side-effect imports that bind nothing', opts, async () => {
  const { imports } = await parse('a.ts', `import './polyfill';`);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].spec, './polyfill');
});

test('preserves relative depth in Python imports', opts, async () => {
  const { imports } = await parse('a.py', `
from ..pkg.mod import thing
`);
  const imp = imports.find((i) => i.symbol === 'thing');
  // Losing the leading dots makes the target unresolvable.
  assert.match(imp.spec, /^\.\./);
});

test('CommonJS require is captured', opts, async () => {
  const { imports } = await parse('a.js', `const lodash = require('lodash');`);
  const imp = imports.find((i) => i.spec === 'lodash');
  assert.ok(imp, 'require() is still how a large share of JS declares dependencies');
  assert.equal(imp.alias, 'lodash');
});

test('arrow functions assigned to consts read as functions', opts, async () => {
  const { nodes } = await parse('a.js', `export const handler = async (req) => { return 1; };`);
  const fn = nodes.find((n) => n.name === 'handler');
  assert.equal(fn.kind, 'function', 'searching for `handler` should find a function');
});

test('a file with no symbols still yields a module node', opts, async () => {
  const { nodes } = await parse('a.js', `// just a comment\n`);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, 'module');
});

test('syntactically broken files do not throw', opts, async () => {
  // Half-typed code is the normal state of a file in an editor, and watch mode
  // will parse it. Extraction must degrade, not crash.
  const { nodes } = await parse('a.ts', `
export class Broken {
  method(: {{{
`);
  assert.ok(Array.isArray(nodes));
});

// ------------------------------------------------- same-range tiebreak
//
// The containment sweep pops the stack when `endByte <= startByte` and the sort
// tiebreak is `b.endByte - a.endByte`. For two sibling definitions with an
// IDENTICAL byte range but DIFFERENT names, the comparator returns 0, so the
// order is whatever the captures arrived in — and whichever is processed first
// ends up the parent of the other (the second nests under the first's stack
// entry). Real grammars rarely emit same-range/different-name captures, so this
// edge was untested. The guard: the parent-child assignment must be DETERMINISTIC
// (stable across repeated calls) and every child range must sit inside its
// parent. `Array.prototype.sort` is stable (ES2019), so equal-keyed definitions
// keep capture order and the first-captured becomes the parent — we pin that.

function sameRangeExtract(nameOrder) {
  const source = 'function a() {}\nfunction b() {}\n';
  // Both definitions share the exact range [0,16); only names differ.
  const mk = (name) => ({
    captures: [
      { name: 'name', text: name, startByte: 0, endByte: 9, startLine: 1, endLine: 1, startCol: 9, type: 'identifier' },
      { name: 'definition.function', text: source.slice(0, 16), startByte: 0, endByte: 16, startLine: 1, endLine: 1, startCol: 0, type: 'function_declaration' },
    ],
  });
  return extract({
    path: 'a.js',
    source,
    captures: { tags: nameOrder.map(mk), imports: [] },
    pack: {},
  });
}

test('same-range, different-name definitions get a deterministic parent', opts, () => {
  const first = sameRangeExtract(['Alpha', 'Beta']);
  const second = sameRangeExtract(['Alpha', 'Beta']);

  const shape = ({ nodes }) =>
    nodes.map((n) => `${n.name}::${n.parentIndex === null ? '-' : nodes[n.parentIndex].name}`);

  // Determinism: identical input order must yield identical parent assignment.
  assert.deepEqual(shape(first), shape(second), 'repeated extraction must be stable');

  // With a stable sort, the first-captured definition is the parent; the second
  // nests under it, and its range is inside the parent (identical range).
  const alpha = first.nodes.find((n) => n.name === 'Alpha');
  const beta = first.nodes.find((n) => n.name === 'Beta');
  assert.ok(alpha && beta, 'both same-range definitions are kept (dedupe keys on name)');
  assert.equal(first.nodes[alpha.parentIndex].kind, 'module', 'first-captured attaches to the module');
  assert.equal(first.nodes[beta.parentIndex].name, 'Alpha', 'second nests under the first');

  // Inversion of capture order inverts the parent — deterministic by capture
  // order, not arbitrary.
  const inv = sameRangeExtract(['Beta', 'Alpha']);
  const invAlpha = inv.nodes.find((n) => n.name === 'Alpha');
  assert.equal(inv.nodes[invAlpha.parentIndex].name, 'Beta', 'capture order is the tiebreak');

  // Every child range stays inside its parent (identical ranges satisfy this).
  for (const n of first.nodes) {
    if (n.parentIndex === null) continue;
    const p = first.nodes[n.parentIndex];
    assert.ok(n.startByte >= p.startByte && n.endByte <= p.endByte, `${n.name} escapes its parent`);
  }
});
