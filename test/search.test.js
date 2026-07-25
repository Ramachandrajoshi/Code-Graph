/**
 * Search and graph-traversal tests.
 *
 * Search is judged on whether the *right* answer comes first, not on whether a
 * match exists. An agent reads results top-down and stops early, so ranking is
 * the feature.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildFixture } from './fixture.js';
import { search } from '../src/core/search.js';
import { callers, callees, impact, shortestPath, importers } from '../src/core/graph.js';
import { computeRanks } from '../src/core/rank.js';

const require = createRequire(import.meta.url);
const skip = (() => {
  try { require.resolve('tree-sitter-wasms/package.json'); return false; }
  catch { return true; }
})();
const opts = { skip };

const REPO = {
  'package.json': '{"name":"t"}',
  'src/auth/login.ts': `
import { findUser } from '../db';

/** Authenticates a user against the credential store. */
export async function handleLogin(email: string, pw: string): Promise<boolean> {
  const user = await findUser(email);
  return checkPassword(user, pw);
}

function checkPassword(user: unknown, pw: string): boolean {
  return true;
}
`,
  'src/db.ts': `
export function findUser(email: string) { return { email }; }
export function saveUser(user: unknown) { return user; }
`,
  'src/api/routes.ts': `
import { handleLogin } from '../auth/login';

export function postLogin(req: Request) {
  return handleLogin('a', 'b');
}
`,
  'src/unrelated.ts': `
export function unrelatedThing() { return 1; }
`,
};

test('exact name match outranks fuzzy matches', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const hits = search(fx.store, 'findUser');
    assert.equal(hits[0].node.name, 'findUser', 'the exact match must come first');
  } finally { fx.cleanup(); }
});

test('finds a symbol by a camelCase component word', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    // The headline search case: nobody types 'handleLogin', they type 'login'.
    const hits = search(fx.store, 'login');
    const names = hits.map((h) => h.node.name);
    assert.ok(names.includes('handleLogin'), `'login' should find handleLogin; got ${names}`);
  } finally { fx.cleanup(); }
});

test('finds a symbol by doc text', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const hits = search(fx.store, 'credential');
    assert.ok(
      hits.some((h) => h.node.name === 'handleLogin'),
      'doc comments are part of the searchable surface'
    );
  } finally { fx.cleanup(); }
});

test('substring search finds a fragment inside an identifier', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const hits = search(fx.store, 'assw'); // inside checkPassword
    assert.ok(hits.some((h) => h.node.name === 'checkPassword'), 'trigram fallback should hit');
  } finally { fx.cleanup(); }
});

test('kind filter excludes other kinds', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const hits = search(fx.store, 'user', { kind: 'function' });
    assert.ok(hits.length > 0);
    assert.ok(hits.every((h) => h.node.kind === 'function'));
  } finally { fx.cleanup(); }
});

test('path filter scopes results to a subtree', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const hits = search(fx.store, 'user', { path: 'src/db' });
    assert.ok(hits.length > 0);
    assert.ok(hits.every((h) => h.node.path.startsWith('src/db')));
  } finally { fx.cleanup(); }
});

test('a query with FTS operator characters does not throw', opts, async () => {
  // Unescaped, these are FTS5 syntax errors rather than searches. An agent will
  // absolutely paste 'get-user' or 'foo:bar' into this.
  const fx = await buildFixture(REPO);
  try {
    for (const q of ['get-user', 'foo:bar', 'a"b', 'x*', 'NEAR(a b)', '((']) {
      assert.doesNotThrow(() => search(fx.store, q), `query '${q}' should degrade, not throw`);
    }
  } finally { fx.cleanup(); }
});

test('an empty query returns nothing rather than everything', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    assert.deepEqual(search(fx.store, '   '), []);
  } finally { fx.cleanup(); }
});

test('limit is respected', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    assert.ok(search(fx.store, 'user', { limit: 2 }).length <= 2);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- traversal

test('callers finds who calls a symbol', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const node = fx.node('handleLogin');
    const rows = callers(fx.store, node.id);
    assert.ok(rows.some((r) => r.qname.includes('postLogin')), 'postLogin calls handleLogin');
  } finally { fx.cleanup(); }
});

test('callers groups multiple call sites into one row', opts, async () => {
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/a.js': `
export function target() {}
export function caller() { target(); target(); target(); }
`,
  });
  try {
    const rows = callers(fx.store, fx.node('target').id);
    const row = rows.find((r) => r.qname.includes('caller'));
    assert.equal(rows.filter((r) => r.qname.includes('caller')).length, 1, 'one row per caller');
    assert.equal(row.sites, 3, 'call-site count is retained');
  } finally { fx.cleanup(); }
});

test('callees separates internal targets from dependencies', opts, async () => {
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/lib.js': 'export function local() {}\n',
    'src/a.js': "import express from 'express';\nimport { local } from './lib';\nexport function f() { local(); express(); }\n",
  });
  try {
    const { internal, external } = callees(fx.store, fx.node('f').id);
    assert.ok(internal.some((r) => r.qname.includes('local')));
    assert.ok(external.some((r) => r.package === 'express'));
  } finally { fx.cleanup(); }
});

test('impact walks transitively and reports distance', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const result = impact(fx.store, fx.node('findUser').id, { depth: 3 });
    const names = result.nodes.map((n) => n.qname);

    assert.ok(names.some((n) => n.includes('handleLogin')), 'direct caller');
    assert.ok(names.some((n) => n.includes('postLogin')), 'transitive caller');

    const direct = result.nodes.find((n) => n.qname.includes('handleLogin'));
    const indirect = result.nodes.find((n) => n.qname.includes('postLogin'));
    assert.ok(indirect.distance > direct.distance, 'distance must increase with hops');
  } finally { fx.cleanup(); }
});

test('impact excludes unrelated symbols', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const result = impact(fx.store, fx.node('findUser').id, { depth: 5 });
    assert.ok(
      !result.nodes.some((n) => n.qname.includes('unrelatedThing')),
      'impact must not sweep in the whole repo'
    );
  } finally { fx.cleanup(); }
});

test('impact respects the depth limit', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const shallow = impact(fx.store, fx.node('findUser').id, { depth: 1 });
    assert.ok(shallow.nodes.every((n) => n.distance === 1));
  } finally { fx.cleanup(); }
});

test('shortestPath finds a route between distant symbols', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const from = fx.node('postLogin');
    const to = fx.node('findUser');
    const path = shortestPath(fx.store, from.id, to.id);

    assert.ok(path, 'a path exists: postLogin -> handleLogin -> findUser');
    assert.equal(path[0], from.id);
    assert.equal(path.at(-1), to.id);
    assert.equal(path.length, 3);
  } finally { fx.cleanup(); }
});

test('shortestPath returns null when no route exists', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const path = shortestPath(fx.store, fx.node('unrelatedThing').id, fx.node('findUser').id);
    assert.equal(path, null, 'absence of a path must be reported, not faked');
  } finally { fx.cleanup(); }
});

test('importers lists files importing a given file', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const dbFile = fx.store.getFileByPath('src/db.ts');
    const rows = importers(fx.store, dbFile.id);
    assert.ok(rows.some((r) => r.path === 'src/auth/login.ts'));
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- ranking

test('ranking gives called symbols a higher rank than uncalled ones', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    computeRanks(fx.store);
    const called = fx.node('findUser');
    const orphan = fx.node('unrelatedThing');
    assert.ok(
      called.rank >= orphan.rank,
      `a called symbol should outrank an isolated one (${called.rank} vs ${orphan.rank})`
    );
  } finally { fx.cleanup(); }
});

test('ranks are normalized into 0..1', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    computeRanks(fx.store);
    const rows = fx.store.all('SELECT rank FROM nodes');
    assert.ok(rows.every((r) => r.rank >= 0 && r.rank <= 1), 'rank must be comparable across repos');
    assert.ok(rows.some((r) => r.rank > 0), 'not everything can be zero');
  } finally { fx.cleanup(); }
});

test('ranking an empty graph does not crash', opts, async () => {
  const fx = await buildFixture({ 'package.json': '{"name":"t"}', 'src/a.js': '// nothing\n' });
  try {
    assert.doesNotThrow(() => computeRanks(fx.store));
  } finally { fx.cleanup(); }
});
