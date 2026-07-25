/**
 * Resolution tests.
 *
 * The central invariant: an edge labelled EXACT was proven, and an edge labelled
 * INFERRED was guessed. Every test below pins one side of that line, because the
 * failure mode is silent — a wrong edge marked EXACT sends an agent confidently
 * to the wrong function, which is worse than no edge at all.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildFixture } from './fixture.js';

const require = createRequire(import.meta.url);
const skip = (() => {
  try { require.resolve('tree-sitter-wasms/package.json'); return false; }
  catch { return true; }
})();
const opts = { skip };

test('resolves a relative import to a repo file', opts, async () => {
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/db.js': 'export function query(sql) { return sql; }\n',
    'src/app.js': "import { query } from './db';\nexport function run() { return query('x'); }\n",
  });
  try {
    const imp = fx.importOf('src/app.js', './db');
    assert.equal(imp.resolved_path, 'src/db.js', 'extensionless relative import must resolve');

    const edge = fx.edge('run', 'query');
    assert.ok(edge, 'run should have an edge to query');
    assert.equal(edge.confidence, 'EXACT', 'an imported call is proven, not guessed');
  } finally { fx.cleanup(); }
});

test('resolves a directory import through index.js', opts, async () => {
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/utils/index.js': 'export function helper() { return 1; }\n',
    'src/app.js': "import { helper } from './utils';\nexport function run() { return helper(); }\n",
  });
  try {
    assert.equal(fx.importOf('src/app.js', './utils').resolved_path, 'src/utils/index.js');
    assert.equal(fx.edge('run', 'helper').confidence, 'EXACT');
  } finally { fx.cleanup(); }
});

test('resolves parent-directory imports', opts, async () => {
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/db.js': 'export function query() {}\n',
    'src/api/handler.js': "import { query } from '../db';\nexport function handle() { return query(); }\n",
  });
  try {
    assert.equal(fx.importOf('src/api/handler.js', '../db').resolved_path, 'src/db.js');
    assert.equal(fx.edge('handle', 'query').confidence, 'EXACT');
  } finally { fx.cleanup(); }
});

test('resolves tsconfig path aliases', opts, async () => {
  // Aliased imports are pervasive in real TypeScript projects. Without alias
  // support a repo using '@/x' throughout would have almost no EXACT edges.
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'tsconfig.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } },
    }),
    'src/models/user.ts': 'export class User { save(): void {} }\n',
    'src/api.ts': "import { User } from '@app/models/user';\nexport function make(): User { return new User(); }\n",
  });
  try {
    assert.equal(fx.importOf('src/api.ts', '@app/models/user').resolved_path, 'src/models/user.ts');
    assert.equal(fx.edge('make', 'User').confidence, 'EXACT');
  } finally { fx.cleanup(); }
});

test('tolerates comments and trailing commas in tsconfig', opts, async () => {
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'tsconfig.json': `{
      // a comment JSON.parse would reject
      "compilerOptions": {
        "baseUrl": ".",
        "paths": { "~/*": ["src/*"] },
      },
    }`,
    'src/lib.ts': 'export function go() {}\n',
    'src/main.ts': "import { go } from '~/lib';\nexport function start() { go(); }\n",
  });
  try {
    assert.equal(fx.importOf('src/main.ts', '~/lib').resolved_path, 'src/lib.ts');
  } finally { fx.cleanup(); }
});

test('classifies bare specifiers as external npm packages', opts, async () => {
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/app.js': "import express from 'express';\nexport function start() { return express(); }\n",
  });
  try {
    const imp = fx.importOf('src/app.js', 'express');
    assert.equal(imp.ext_package, 'express');
    assert.equal(imp.ecosystem, 'npm');

    const edges = fx.edgesFrom('start');
    const ext = edges.find((e) => e.ext_package === 'express');
    assert.ok(ext, 'a call into a dependency should produce an external edge');
  } finally { fx.cleanup(); }
});

test('credits deep and scoped imports to the right package', opts, async () => {
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/a.js': "import merge from 'lodash/merge';\nimport { z } from '@scope/pkg/sub';\nexport function f(){ return merge(z); }\n",
  });
  try {
    assert.equal(fx.importOf('src/a.js', 'lodash/merge').ext_package, 'lodash');
    assert.equal(fx.importOf('src/a.js', '@scope/pkg/sub').ext_package, '@scope/pkg',
      'a scoped package keeps both segments');
  } finally { fx.cleanup(); }
});

test('same-file references resolve as EXACT without an import', opts, async () => {
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/a.js': 'function helper() { return 1; }\nexport function main() { return helper(); }\n',
  });
  try {
    assert.equal(fx.edge('main', 'helper').confidence, 'EXACT', 'lexical scope is proof');
  } finally { fx.cleanup(); }
});

test('an unimported cross-file name match is INFERRED, not EXACT', opts, async () => {
  // The critical negative case. `main` never imports `orphan`, so any edge is a
  // guess and must be labelled one — even though the name is unique.
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/other.js': 'export function orphanHelper() { return 1; }\n',
    'src/a.js': 'export function main() { return orphanHelper(); }\n',
  });
  try {
    const edge = fx.edge('main', 'orphanHelper');
    assert.ok(edge, 'a unique name match is still worth an edge');
    assert.equal(edge.confidence, 'INFERRED', 'no import means no proof');
  } finally { fx.cleanup(); }
});

test('member calls resolve through the imported receiver', opts, async () => {
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/db.js': 'export function find(id) { return id; }\nexport const db = { find };\n',
    'src/a.js': "import { db } from './db';\nexport function get() { return db.find(1); }\n",
  });
  try {
    const edge = fx.edge('get', 'find');
    assert.ok(edge, 'db.find() should resolve via the db import');
    assert.equal(edge.confidence, 'EXACT');
  } finally { fx.cleanup(); }
});

test('prefers an exported definition when several share a name', opts, async () => {
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/internal.js': 'function shared() { return 1; }\n',
    'src/public.js': 'export function shared() { return 2; }\n',
    'src/a.js': 'export function main() { return shared(); }\n',
  });
  try {
    const edge = fx.edge('main', 'shared');
    assert.equal(edge.confidence, 'INFERRED');
    assert.equal(edge.dst_path, 'src/public.js',
      'an unexported symbol in another file cannot be the target');
  } finally { fx.cleanup(); }
});

test('language builtins are classified, not reported as unresolved', opts, async () => {
  // Without this, prototype methods are the majority of all references and the
  // resolution-quality metric becomes meaningless.
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/a.js': `export function f(xs) {
  const m = new Map();
  return xs.map(x => x).filter(Boolean).join(',') + JSON.stringify(m);
}
`,
  });
  try {
    const unresolved = fx.store.all(
      "SELECT name FROM unresolved WHERE name IN ('map','filter','join','Map','stringify')"
    );
    assert.deepEqual(unresolved, [], 'runtime calls are not resolution failures');

    const edges = fx.edgesFrom('f');
    assert.ok(edges.some((e) => e.ecosystem === 'builtin'), 'they become builtin edges');
  } finally { fx.cleanup(); }
});

test('a local function shadows a builtin method name', opts, async () => {
  // `filter()` with no receiver is far more likely to be a project helper, and
  // misclassifying it as Array.prototype.filter would hide a real edge.
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/a.js': 'function filter(xs) { return xs; }\nexport function main(xs) { return filter(xs); }\n',
  });
  try {
    const edge = fx.edge('main', 'filter');
    assert.ok(edge, 'the local definition must win');
    assert.equal(edge.confidence, 'EXACT');
  } finally { fx.cleanup(); }
});

test('recursion does not create a self-edge', opts, async () => {
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/a.js': 'export function fact(n) { return n <= 1 ? 1 : n * fact(n - 1); }\n',
  });
  try {
    const self = fx.edgesFrom('fact').find((e) => e.dst_name === 'fact');
    assert.equal(self, undefined, 'a self-edge adds nothing to impact analysis');
  } finally { fx.cleanup(); }
});

test('re-indexing does not duplicate edges', opts, async () => {
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/db.js': 'export function query() {}\n',
    'src/a.js': "import { query } from './db';\nexport function run() { query(); }\n",
  });
  try {
    const before = fx.store.stats().edges;

    const { Indexer } = await import('../src/core/indexer.js');
    const { DEFAULTS } = await import('../src/core/config.js');
    await new Indexer({
      store: fx.store,
      config: { ...DEFAULTS, root: fx.root, dir: fx.root + '/.codegraph' },
      registry: fx.registry,
    }).run({ force: true });

    assert.equal(fx.store.stats().edges, before, 'a re-index must be idempotent');
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- Python

test('resolves Python relative imports', opts, async () => {
  const fx = await buildFixture({
    'pyproject.toml': '[project]\nname = "t"\n',
    'app/__init__.py': '',
    'app/db.py': 'def query(sql):\n    return sql\n',
    'app/main.py': 'from .db import query\n\ndef run():\n    return query("x")\n',
  });
  try {
    assert.equal(fx.importOf('app/main.py', '.db').resolved_path, 'app/db.py');
    assert.equal(fx.edge('run', 'query').confidence, 'EXACT');
  } finally { fx.cleanup(); }
});

test('resolves Python package imports through __init__.py', opts, async () => {
  const fx = await buildFixture({
    'pyproject.toml': '[project]\nname = "t"\n',
    'app/__init__.py': 'def bootstrap():\n    pass\n',
    'main.py': 'from app import bootstrap\n\ndef start():\n    bootstrap()\n',
  });
  try {
    assert.equal(fx.importOf('main.py', 'app').resolved_path, 'app/__init__.py');
  } finally { fx.cleanup(); }
});

test('Python stdlib is not reported as a third-party dependency', opts, async () => {
  const fx = await buildFixture({
    'pyproject.toml': '[project]\nname = "t"\n',
    'main.py': 'import os\nimport requests\n\ndef f():\n    return os.path.join("a")\n',
  });
  try {
    assert.equal(fx.importOf('main.py', 'os').ecosystem, 'python-stdlib');
    assert.equal(fx.importOf('main.py', 'requests').ecosystem, 'pypi',
      'a real dependency must not be buried in stdlib noise');
  } finally { fx.cleanup(); }
});

test('resolution stats are reported honestly', opts, async () => {
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/db.js': 'export function query() {}\n',
    'src/a.js': "import { query } from './db';\nexport function run() { query(); }\nexport function guess() { return mystery(); }\n",
  });
  try {
    const r = fx.stats.resolution;
    assert.ok(r.exact >= 1, 'the imported call is exact');
    assert.ok(r.unresolved >= 1, 'an unknown name is reported, not silently dropped');

    const rows = fx.store.all("SELECT name FROM unresolved WHERE name = 'mystery'");
    assert.equal(rows.length, 1, 'unresolved references are kept for doctor');
  } finally { fx.cleanup(); }
});
