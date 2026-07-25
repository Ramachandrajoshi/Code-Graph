/**
 * Dependency documentation tests.
 *
 * The distinguishing feature is usage ranking: `docs express` must return the
 * functions THIS project calls, not the whole Express API. Tests here pin that
 * behaviour and the offline-first contract — extraction must never require the
 * network, and must never fail an index when the network is absent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildFixture } from './fixture.js';
import { extractAllDocs } from '../src/deps/extract.js';
import { lookupDocs, listDependencies } from '../src/deps/lookup.js';

const require = createRequire(import.meta.url);
const skip = (() => {
  try { require.resolve('tree-sitter-wasms/package.json'); return false; }
  catch { return true; }
})();
const opts = { skip };

/** A fixture with a fake node_modules package carrying real .d.ts types. */
function withFakePackage(extra = {}) {
  return {
    'package.json': '{"name":"app","dependencies":{"tinylib":"1.0.0"}}',
    'node_modules/tinylib/package.json': JSON.stringify({
      name: 'tinylib', version: '2.3.4', types: 'index.d.ts',
      description: 'A tiny library.',
    }),
    'node_modules/tinylib/index.d.ts': `
/** Creates a widget. */
export declare function createWidget(name: string, size?: number): Widget;

/** Destroys a widget. */
export declare function destroyWidget(w: Widget): void;

export declare class Widget {
  readonly name: string;
  resize(size: number): void;
}

export declare const VERSION: string;
`,
    ...extra,
  };
}

test('extracts signatures from a local node_modules .d.ts', opts, async () => {
  const fx = await buildFixture(withFakePackage({
    'src/app.js': "import { createWidget } from 'tinylib';\nexport function go() { return createWidget('a'); }\n",
  }));
  try {
    const result = await extractAllDocs(fx.store, {
      root: fx.root, deps: { maxPackages: 50 },
    }, { offline: true });

    assert.ok(result.packages >= 1, 'the local package should be read');

    const row = fx.store.get(
      "SELECT * FROM externals WHERE package = 'tinylib' AND symbol = 'createWidget'"
    );
    assert.ok(row, 'createWidget should be recorded');
    assert.match(row.signature, /createWidget\(name: string/);
    assert.equal(row.doc, 'Creates a widget.');
    assert.equal(row.version, '2.3.4', 'version comes from the installed package');
  } finally { fx.cleanup(); }
});

test('extraction never resets usage counts', opts, async () => {
  // use_count is produced by resolution and is the whole point of the feature;
  // a doc refresh that clobbered it would silently destroy the ranking.
  const fx = await buildFixture(withFakePackage({
    'src/app.js': "import { createWidget } from 'tinylib';\nexport function a() { createWidget('x'); }\nexport function b() { createWidget('y'); }\n",
  }));
  try {
    const before = fx.store.get(
      "SELECT use_count FROM externals WHERE package = 'tinylib' AND symbol = 'createWidget'"
    )?.use_count ?? 0;
    assert.ok(before > 0, 'resolution should have counted the calls');

    await extractAllDocs(fx.store, { root: fx.root, deps: {} }, { offline: true });

    const after = fx.store.get(
      "SELECT use_count FROM externals WHERE package = 'tinylib' AND symbol = 'createWidget'"
    ).use_count;
    assert.equal(after, before, 'usage counts must survive a docs refresh');
  } finally { fx.cleanup(); }
});

test('docs ranks symbols by how often this project calls them', opts, async () => {
  const fx = await buildFixture(withFakePackage({
    'src/app.js': `import { createWidget, destroyWidget } from 'tinylib';
export function a() { createWidget('1'); }
export function b() { createWidget('2'); }
export function c() { createWidget('3'); }
export function d() { destroyWidget(null); }
`,
  }));
  try {
    await extractAllDocs(fx.store, { root: fx.root, deps: {} }, { offline: true });
    const result = lookupDocs(fx.store, {}, { pkg: 'tinylib', top: 10 });
    const text = result.lines.join('\n');

    const createAt = text.indexOf('createWidget');
    const destroyAt = text.indexOf('destroyWidget');
    assert.ok(createAt !== -1 && destroyAt !== -1, 'both symbols listed');
    assert.ok(createAt < destroyAt, 'the more-used symbol comes first');
  } finally { fx.cleanup(); }
});

test('docs reports where a dependency symbol is used in this repo', opts, async () => {
  // This is what a documentation website cannot provide, and it is usually the
  // fastest route to a working example.
  const fx = await buildFixture(withFakePackage({
    'src/app.js': "import { createWidget } from 'tinylib';\nexport function go() { return createWidget('a'); }\n",
  }));
  try {
    await extractAllDocs(fx.store, { root: fx.root, deps: {} }, { offline: true });
    const text = lookupDocs(fx.store, {}, { pkg: 'tinylib' }).lines.join('\n');
    assert.match(text, /used: src\/app\.js:\d+/);
  } finally { fx.cleanup(); }
});

test('an unknown package is reported with near matches', opts, async () => {
  const fx = await buildFixture(withFakePackage({
    'src/app.js': "import { createWidget } from 'tinylib';\nexport function go() { createWidget('a'); }\n",
  }));
  try {
    const text = lookupDocs(fx.store, {}, { pkg: 'tiny' }).lines.join('\n');
    assert.match(text, /not a dependency/);
    assert.match(text, /tinylib/, 'a near miss should be suggested rather than a bare failure');
  } finally { fx.cleanup(); }
});

test('third-party packages outrank standard library in the listing', opts, async () => {
  // `fs` and `path` are used more than any npm package in nearly every Node
  // project; letting them head the list buries the real answer.
  const fx = await buildFixture(withFakePackage({
    'src/app.js': `import fs from 'node:fs';
import path from 'node:path';
import { createWidget } from 'tinylib';
export function go() {
  fs.readFileSync('a'); fs.writeFileSync('b', 'c'); path.join('d'); path.resolve('e');
  return createWidget('f');
}
`,
  }));
  try {
    const deps = listDependencies(fx.store, { limit: 20 });
    const firstStdlibIndex = deps.findIndex((d) => d.stdlib);
    const tinylibIndex = deps.findIndex((d) => d.package === 'tinylib');

    assert.ok(tinylibIndex !== -1, 'the real dependency is listed');
    if (firstStdlibIndex !== -1) {
      assert.ok(tinylibIndex < firstStdlibIndex, 'third-party sorts first');
    }
  } finally { fx.cleanup(); }
});

test('extraction works offline and reports what it could not read', opts, async () => {
  const fx = await buildFixture({
    'package.json': '{"name":"app"}',
    'src/app.js': "import express from 'express';\nexport function go() { return express(); }\n",
  });
  try {
    const result = await extractAllDocs(fx.store, { root: fx.root, deps: {} }, { offline: true });
    // express is not installed and the network is off: the correct outcome is a
    // recorded failure, not an exception and not a silent success.
    assert.ok(result.failed >= 1, 'unavailable packages are counted');
    assert.equal(result.packages, 0);
  } finally { fx.cleanup(); }
});

test('a malformed package.json does not abort extraction', opts, async () => {
  const fx = await buildFixture(withFakePackage({
    'node_modules/brokenlib/package.json': '{ not json',
    'src/app.js': "import { createWidget } from 'tinylib';\nimport b from 'brokenlib';\nexport function go() { createWidget(b); }\n",
  }));
  try {
    const result = await extractAllDocs(fx.store, { root: fx.root, deps: {} }, { offline: true });
    assert.ok(result.packages >= 1, 'the healthy package is still extracted');
  } finally { fx.cleanup(); }
});

test('oversized type files are skipped rather than indexed', opts, async () => {
  // A 5 MB bundled .d.ts yields thousands of symbols nobody asked for and
  // dominates extraction time.
  const huge = 'export declare function f0(): void;\n'.repeat(80000);
  const fx = await buildFixture(withFakePackage({
    'node_modules/biglib/package.json': JSON.stringify({ name: 'biglib', version: '1.0.0', types: 'index.d.ts' }),
    'node_modules/biglib/index.d.ts': huge,
    // Import both, so the assertion that healthy packages still succeed is
    // actually testing something.
    'src/app.js': "import { f0 } from 'biglib';\nimport { createWidget } from 'tinylib';\nexport function go() { f0(); createWidget('a'); }\n",
  }));
  try {
    assert.ok(fs.statSync(path.join(fx.root, 'node_modules/biglib/index.d.ts')).size > 2 * 1024 * 1024);
    const result = await extractAllDocs(fx.store, { root: fx.root, deps: {} }, { offline: true });
    const rows = fx.store.all("SELECT symbol FROM externals WHERE package = 'biglib' AND signature IS NOT NULL");
    assert.equal(rows.length, 0, 'the oversized file is not parsed');
    assert.ok(result.packages >= 1, 'other packages still succeed');
  } finally { fx.cleanup(); }
});

test('node_modules is found in a parent directory (monorepo hoisting)', opts, async () => {
  // Workspaces hoist dependencies to the repo root; a single-directory lookup
  // finds nothing in a package subdirectory.
  const fx = await buildFixture({
    'package.json': '{"name":"root","workspaces":["packages/*"]}',
    'node_modules/tinylib/package.json': JSON.stringify({ name: 'tinylib', version: '1.0.0', types: 'index.d.ts' }),
    'node_modules/tinylib/index.d.ts': '/** Makes a thing. */\nexport declare function make(): void;\n',
    'packages/app/package.json': '{"name":"app"}',
    'packages/app/src/index.js': "import { make } from 'tinylib';\nexport function go() { make(); }\n",
  });
  try {
    const result = await extractAllDocs(fx.store, { root: fx.root, deps: {} }, { offline: true });
    assert.ok(result.packages >= 1, 'hoisted dependency should be located');
    const row = fx.store.get("SELECT * FROM externals WHERE package = 'tinylib' AND symbol = 'make'");
    assert.equal(row.doc, 'Makes a thing.');
  } finally { fx.cleanup(); }
});

test('follows the exports map to a type entry', opts, async () => {
  const fx = await buildFixture({
    'package.json': '{"name":"app"}',
    'node_modules/modern/package.json': JSON.stringify({
      name: 'modern', version: '3.0.0',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    }),
    'node_modules/modern/dist/index.d.ts': '/** Runs it. */\nexport declare function run(): void;\n',
    'src/app.js': "import { run } from 'modern';\nexport function go() { run(); }\n",
  });
  try {
    await extractAllDocs(fx.store, { root: fx.root, deps: {} }, { offline: true });
    const row = fx.store.get("SELECT * FROM externals WHERE package = 'modern' AND symbol = 'run'");
    assert.ok(row, 'exports["."].types should be followed');
    assert.equal(row.doc, 'Runs it.');
  } finally { fx.cleanup(); }
});
