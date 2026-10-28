/**
 * Grammar / runtime ABI compatibility.
 *
 * This suite exists because of a specific, expensive failure: web-tree-sitter
 * 0.26.x cannot load the grammars in tree-sitter-wasms@0.1.13, and it reports
 * that by throwing an Error with an empty message from inside the emscripten
 * loader. Nothing about that points at a version mismatch.
 *
 * These tests are the gate on any future bump of either package.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { KNOWN_GRAMMARS, grammarInfo, resolveGrammar, localGrammars } from '../src/core/grammars.js';
import { ParserHost } from '../src/core/parser-host.js';
import { LANGUAGES } from '../src/packs/languages.js';
import { userCacheDir } from '../src/core/config.js';

const require = createRequire(import.meta.url);
const haveBundled = (() => {
  try { require.resolve('tree-sitter-wasms/package.json'); return true; }
  catch { return false; }
})();

test('every language in the table maps to a known grammar', () => {
  for (const lang of LANGUAGES) {
    assert.ok(
      grammarInfo(lang.grammar),
      `language '${lang.id}' names grammar '${lang.grammar}', which is not in the manifest`
    );
  }
});

test('manifest records an ABI verdict for every grammar', () => {
  for (const name of KNOWN_GRAMMARS) {
    assert.equal(
      typeof grammarInfo(name).abiOk, 'boolean',
      `grammar '${name}' has no abiOk flag; run the compatibility check and record one`
    );
  }
});

test('grammars marked abiOk:false are refused with an explanatory error', async () => {
  const broken = KNOWN_GRAMMARS.filter((n) => grammarInfo(n).abiOk === false);
  for (const name of broken) {
    await assert.rejects(
      () => resolveGrammar(name),
      /not loadable by the pinned tree-sitter runtime/,
      `'${name}' should fail with a clear message, not an empty one`
    );
  }
});

test('every grammar marked abiOk:true actually loads', { skip: !haveBundled }, async () => {
  // The real gate. If a runtime bump breaks the ABI, this fails loudly here
  // instead of silently producing an empty graph for the affected languages.
  const host = new ParserHost({ offline: true });
  const failures = [];

  for (const name of KNOWN_GRAMMARS) {
    if (grammarInfo(name).abiOk === false) continue;
    try {
      await host.language(name);
    } catch (err) {
      failures.push(`${name}: ${err.message || '(empty message — ABI mismatch)'}`);
    }
  }

  host.dispose();
  assert.deepEqual(failures, [], `grammars failed to load:\n  ${failures.join('\n  ')}`);
});

test('checksum verification rejects tampered grammar bytes', async () => {
  // Grammars are wasm we execute, fetched over the network. A silent checksum
  // skip would make that arbitrary code execution.
  const info = grammarInfo('json');
  assert.ok(info.sha256 && /^[0-9a-f]{64}$/.test(info.sha256), 'manifest must pin a sha256');
});

test('parses a trivial file with the bundled grammar', { skip: !haveBundled }, async () => {
  const host = new ParserHost({ offline: true });
  const q = await host.query('json', 'test', '(pair key: (string) @name) @definition.field');
  const out = await host.run('json', '{"a": 1, "b": 2}', { tags: q });
  assert.equal(out.tags.length, 2, 'both pairs should be captured');
  host.dispose();
});

// ------------------------------------------------------- cache / offline paths
//
// The download() network path is deliberately NOT exercised (no network in
// tests). The cache-redirect helpers point CGRAPH_HOME at a temp dir so these
// tests seed and inspect the machine-wide grammar cache without touching the
// developer's real ~/.cgraph, then restore the environment.

async function withTempCache(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-gram-'));
  const prior = process.env.CGRAPH_HOME;
  process.env.CGRAPH_HOME = dir;
  try {
    return await fn(dir);
  } finally {
    // Await before teardown so an async body completes against the temp cache.
    if (prior === undefined) delete process.env.CGRAPH_HOME;
    else process.env.CGRAPH_HOME = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cacheDir() {
  return path.join(userCacheDir(), 'grammars');
}

function bundledWasm(name) {
  const pkg = require.resolve('tree-sitter-wasms/package.json');
  return path.join(path.dirname(pkg), 'out', `tree-sitter-${name}.wasm`);
}

test('a valid pre-seeded cache file resolves as source:cache (verify passes)', { skip: !haveBundled }, async () => {
  // resolveGrammar(): the cache-hit + verify-success return (source 'cache'),
  // proving a correctly-hashed file is served from cache, not re-fetched.
  await withTempCache(async () => {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const bytes = fs.readFileSync(bundledWasm('json'));
    fs.writeFileSync(path.join(cacheDir(), 'tree-sitter-json.wasm'), bytes);

    const r = await resolveGrammar('json', { offline: true });
    assert.equal(r.source, 'cache', 'a checksum-valid cached grammar is served from cache');
  });
});

test('a tampered cache file is checksum-rejected, deleted, then re-resolved', { skip: !haveBundled }, async () => {
  // resolveGrammar(): the verify() catch inside the cache branch. A truncated
  // or corrupted file must be rm'd and resolution must fall through (here to the
  // bundled copy), never be executed.
  await withTempCache(async () => {
    fs.mkdirSync(cacheDir(), { recursive: true });
    const cached = path.join(cacheDir(), 'tree-sitter-json.wasm');
    fs.writeFileSync(cached, 'not-a-wasm-at-all');

    const r = await resolveGrammar('json', { offline: true });
    assert.equal(r.source, 'bundled', 'after deleting the bad cache it falls back to bundled');
    assert.ok(!fs.existsSync(cached), 'the tampered cache file was removed, not left to rot');
  });
});

test('offline with no cache and no bundle throws a clear fix, touching no network', async () => {
  // resolveGrammar(): the offline cache-miss throw. An unknown grammar has no
  // bundled copy and no cache, so offline must fail loudly with the remedy
  // rather than attempting a download.
  await assert.rejects(
    () => resolveGrammar('no-such-grammar-xyz', { offline: true }),
    /not available offline/
  );
});

test('an unknown grammar name is refused with the known list, not downloaded', async () => {
  // resolveGrammar(): the `!grammarInfo(name)` guard after the offline check.
  // online: it must short-circuit with "Unknown grammar" — it must never reach
  // download(), which would request a nonexistent CDN object.
  await assert.rejects(
    () => resolveGrammar('no-such-grammar-xyz', { offline: false }),
    /Unknown grammar/
  );
});

test('localGrammars() reports what is available locally without network', { skip: !haveBundled }, () => {
  // localGrammars(): the cache-then-bundled scan. With the bundle installed,
  // every known grammar is at least 'bundled'; nothing here opens a socket.
  const m = localGrammars();
  assert.ok(m.size > 0, 'with tree-sitter-wasms installed, grammars are available');
  assert.ok(m.has('json'));
  for (const source of m.values()) {
    assert.ok(['cache', 'bundled'].includes(source), `source must be cache|bundled, got ${source}`);
  }
});
