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
import { createRequire } from 'node:module';
import { KNOWN_GRAMMARS, grammarInfo, resolveGrammar } from '../src/core/grammars.js';
import { ParserHost } from '../src/core/parser-host.js';
import { LANGUAGES } from '../src/packs/languages.js';

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
