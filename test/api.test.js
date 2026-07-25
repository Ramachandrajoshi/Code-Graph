/**
 * Programmatic API tests.
 *
 * The public entry points are part of the package contract: `code-graph` and
 * `code-graph/sdk` are declared in `exports`, so breaking them breaks consumers
 * silently at import time. These tests import them exactly as an installed
 * package would.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { openProject } from '../src/index.js';

const require = createRequire(import.meta.url);
const skip = (() => {
  try { require.resolve('tree-sitter-wasms/package.json'); return false; }
  catch { return true; }
})();
const opts = { skip };

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-api-'));
  const files = {
    'package.json': '{"name":"demo"}',
    'src/db.js': 'export function findUser(id) { return id; }\n',
    'src/auth.js': "import { findUser } from './db';\nexport function handleLogin(e) { return findUser(e); }\n",
    'src/api.js': "import { handleLogin } from './auth';\nexport function postLogin(r) { return handleLogin(r); }\n",
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

test('the package entry point exports its documented surface', async () => {
  const api = await import('../src/index.js');
  for (const name of [
    'openProject', 'loadConfig', 'Store', 'Indexer', 'PackRegistry',
    'outlineFile', 'findSymbol', 'readSymbol', 'graph', 'estimate',
    'listDependencies', 'lookupDocs',
  ]) {
    assert.ok(api[name], `'${name}' should be exported from the package root`);
  }
});

test('the sdk entry point exports its documented surface', async () => {
  const sdk = await import('../src/sdk/index.js');
  for (const name of [
    'definePack', 'validatePack', 'makeTestContext', 'CAPTURES',
    'tryCandidates', 'normalizeRelative', 'splitIdentifier', 'EXACT', 'INFERRED',
  ]) {
    assert.ok(sdk[name], `'${name}' should be exported from code-graph/sdk`);
  }
});

test('openProject indexes and answers queries', opts, async () => {
  const root = makeRepo();
  const project = await openProject(root);
  try {
    const stats = await project.index();
    assert.ok(stats.parsed >= 3, 'all source files indexed');

    const hits = project.find('findUser');
    assert.equal(hits[0].node.name, 'findUser');

    const read = project.read('findUser');
    assert.match(read.lines.join('\n'), /export function findUser/);

    const callers = project.callers('findUser');
    assert.ok(callers.some((c) => c.qname.includes('handleLogin')));

    const impact = project.impact('findUser', { depth: 3 });
    assert.ok(impact.nodes.some((n) => n.qname.includes('postLogin')), 'transitive');

    const route = project.path('postLogin', 'findUser');
    assert.equal(route.length, 3, 'postLogin -> handleLogin -> findUser');
  } finally {
    project.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('map works for a file and for the repo', opts, async () => {
  const root = makeRepo();
  const project = await openProject(root);
  try {
    await project.index();

    const file = project.map('src/db.js');
    assert.match(file.lines.join('\n'), /findUser/);

    const repo = project.map();
    assert.match(repo.lines.join('\n'), /src/);
  } finally {
    project.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('queries for a missing symbol return empty rather than throwing', opts, async () => {
  // A library consumer should be able to probe without try/catch around
  // every call.
  const root = makeRepo();
  const project = await openProject(root);
  try {
    await project.index();
    assert.equal(project.read('nothingHere'), null);
    assert.deepEqual(project.callers('nothingHere'), []);
    assert.deepEqual(project.impact('nothingHere').nodes, []);
    assert.equal(project.path('nothingHere', 'alsoMissing'), null);
  } finally {
    project.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stats include the savings ledger', opts, async () => {
  const root = makeRepo();
  const project = await openProject(root);
  try {
    await project.index();
    const stats = project.stats();
    assert.ok(stats.nodes > 0);
    assert.ok(stats.edges > 0);
    assert.ok(stats.counters, 'counters are exposed for reporting');
  } finally {
    project.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('openProject refuses a missing index when create is false', opts, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-api-none-'));
  try {
    await assert.rejects(
      () => openProject(root, { create: false }),
      /cgraph init/,
      'the error should say how to fix it'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
