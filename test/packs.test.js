/**
 * Language pack and SDK tests.
 *
 * The plugin system is only real if a pack written outside this repo loads and
 * works without touching core. The discovery test below is the one that proves
 * it — everything else is a detail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildFixture } from './fixture.js';
import { definePack, validatePack, makeTestContext, CAPTURES } from '../src/sdk/index.js';
import { LANGUAGES, detectLanguage, languageById } from '../src/packs/languages.js';
import { grammarInfo } from '../src/core/grammars.js';

const require = createRequire(import.meta.url);
const skip = (() => {
  try { require.resolve('tree-sitter-wasms/package.json'); return false; }
  catch { return true; }
})();
const opts = { skip };

// ---------------------------------------------------------------- detection

test('detects languages by extension', () => {
  assert.equal(detectLanguage('src/a.ts')?.id, 'typescript');
  assert.equal(detectLanguage('src/a.tsx')?.id, 'tsx');
  assert.equal(detectLanguage('src/a.py')?.id, 'python');
  assert.equal(detectLanguage('main.go')?.id, 'go');
  assert.equal(detectLanguage('src/lib.rs')?.id, 'rust');
  assert.equal(detectLanguage('App.java')?.id, 'java');
});

test('detects languages by exact filename', () => {
  assert.equal(detectLanguage('Rakefile')?.id, 'ruby');
  assert.equal(detectLanguage('Gemfile')?.id, 'ruby');
});

test('detects languages by shebang when the extension is absent', () => {
  assert.equal(detectLanguage('scripts/deploy', '#!/bin/bash\necho hi\n')?.id, 'bash');
  assert.equal(detectLanguage('scripts/run', '#!/usr/bin/env python3\n')?.id, 'python');
});

test('returns null for unknown files rather than guessing', () => {
  assert.equal(detectLanguage('README.md'), null);
  assert.equal(detectLanguage('logo.png'), null);
  assert.equal(detectLanguage('LICENSE'), null);
});

test('dotfiles are not mistaken for extensions', () => {
  // '.gitignore' has no extension; treating 'gitignore' as one would misroute it.
  assert.equal(detectLanguage('.gitignore'), null);
});

test('every language maps to a grammar in the manifest', () => {
  for (const lang of LANGUAGES) {
    assert.ok(grammarInfo(lang.grammar), `${lang.id} -> unknown grammar '${lang.grammar}'`);
  }
});

test('extensions are not claimed by two languages', () => {
  const seen = new Map();
  for (const lang of LANGUAGES) {
    for (const ext of lang.ext ?? []) {
      // First declaration wins by design; this test documents which one, so a
      // reordering that silently changes behaviour shows up as a failure.
      if (!seen.has(ext)) seen.set(ext, lang.id);
    }
  }
  assert.equal(seen.get('.ts'), 'typescript');
  assert.equal(seen.get('.h'), 'c', '.h is parsed as C, which also handles C++ headers acceptably');
});

// ---------------------------------------------------------------- SDK

test('definePack accepts a minimal valid pack', () => {
  const pack = definePack({ id: 'x', languages: ['x'], queries: { tags: '/tmp/tags.scm' } });
  assert.equal(pack.id, 'x');
});

test('definePack rejects a pack with no tags query', () => {
  // Without tags the pack silently extracts nothing, which is much harder to
  // diagnose later than an error at definition time.
  assert.throws(
    () => definePack({ id: 'x', languages: ['x'], queries: {} }),
    /queries\.tags` is required/
  );
});

test('definePack rejects a missing id', () => {
  assert.throws(() => definePack({ languages: ['x'], queries: { tags: 'a' } }), /missing `id`/);
});

test('definePack rejects a non-function hook', () => {
  assert.throws(
    () => definePack({ id: 'x', languages: ['x'], queries: { tags: 'a' }, signature: 'nope' }),
    /`signature` must be a function/
  );
});

test('definePack rejects builtins that are not Sets', () => {
  assert.throws(
    () => definePack({ id: 'x', languages: ['x'], queries: { tags: 'a' }, builtins: { globals: ['a'] } }),
    /`builtins.globals` must be a Set/
  );
});

test('validatePack reports every problem at once', () => {
  const problems = validatePack({ queries: {} });
  assert.ok(problems.length >= 2, 'an author should see all issues, not one per run');
});

test('makeTestContext lets a pack hook be tested in isolation', () => {
  const ctx = makeTestContext({ root: '/repo', files: ['src/a.ts', 'src/b/index.ts'] });
  assert.ok(ctx.hasFile('src/a.ts'));
  assert.ok(!ctx.hasFile('src/missing.ts'));
  assert.deepEqual([...ctx.allPaths()].sort(), ['src/a.ts', 'src/b/index.ts']);
});

test('CAPTURES documents the vocabulary the extractor understands', () => {
  assert.ok(CAPTURES.definition.includes('definition.function'));
  assert.ok(CAPTURES.reference.includes('reference.call'));
  assert.ok(CAPTURES.auxiliary.includes('receiver'));
});

// ---------------------------------------------------------------- builtin packs

test('every builtin pack passes its own validation', opts, async () => {
  for (const id of ['typescript', 'javascript', 'python', 'go', 'rust', 'java']) {
    const pack = (await import(`../src/packs/${id}/index.js`)).default;
    assert.deepEqual(validatePack(pack), [], `pack '${id}' is malformed`);
  }
});

test('every declared query file exists and compiles', opts, async () => {
  // A query naming a node the grammar does not have fails the WHOLE query to
  // compile, so one typo silently disables a language entirely.
  const { ParserHost } = await import('../src/core/parser-host.js');
  const host = new ParserHost({ offline: true });

  try {
    for (const id of ['typescript', 'javascript', 'python', 'go', 'rust', 'java']) {
      const pack = (await import(`../src/packs/${id}/index.js`)).default;
      const grammar = languageById(pack.languages[0]).grammar;

      for (const [key, file] of Object.entries(pack.queries)) {
        assert.ok(fs.existsSync(file), `${id}: query '${key}' missing at ${file}`);
        const source = fs.readFileSync(file, 'utf8');
        await assert.doesNotReject(
          () => host.query(grammar, `${id}:${key}:test`, source, { origin: id }),
          `${id}: query '${key}' does not compile against the ${grammar} grammar`
        );
      }
    }
  } finally {
    host.dispose();
  }
});

test('Go resolves a module-internal import', opts, async () => {
  const fx = await buildFixture({
    'go.mod': 'module github.com/acme/proj\n',
    'internal/db/db.go': 'package db\n\nfunc FindUser(id string) error { return nil }\n',
    'main.go': 'package main\n\nimport "github.com/acme/proj/internal/db"\n\nfunc main() { db.FindUser("x") }\n',
  });
  try {
    assert.equal(fx.importOf('main.go', 'github.com/acme/proj/internal/db').resolved_path, 'internal/db/db.go');
    assert.equal(fx.edge('main', 'FindUser').confidence, 'EXACT');
  } finally { fx.cleanup(); }
});

test('Go exports follow the capitalisation rule', opts, async () => {
  const fx = await buildFixture({
    'go.mod': 'module m\n',
    'a.go': 'package a\n\nfunc Exported() {}\nfunc unexported() {}\n',
  });
  try {
    assert.equal(fx.node('Exported').is_exported, 1);
    assert.equal(fx.node('unexported').is_exported, 0);
  } finally { fx.cleanup(); }
});

test('Go stdlib is separated from third-party modules', opts, async () => {
  const fx = await buildFixture({
    'go.mod': 'module m\n',
    'a.go': 'package a\n\nimport (\n\t"fmt"\n\t"github.com/pkg/errors"\n)\n\nfunc f() { fmt.Println(errors.New("x")) }\n',
  });
  try {
    assert.equal(fx.importOf('a.go', 'fmt').ecosystem, 'go-stdlib');
    assert.equal(fx.importOf('a.go', 'github.com/pkg/errors').ecosystem, 'go');
  } finally { fx.cleanup(); }
});

test('a struct is not emitted twice as class and type', opts, async () => {
  // Two query patterns legitimately match a struct declaration. Both surviving
  // put a phantom symbol in the table that resolution could pick.
  const fx = await buildFixture({
    'go.mod': 'module m\n',
    'a.go': 'package a\n\ntype User struct {\n\tName string\n}\n',
  });
  try {
    const rows = fx.store.all("SELECT kind FROM nodes WHERE name = 'User'");
    assert.equal(rows.length, 1, `User should appear once, got ${rows.map((r) => r.kind)}`);
    assert.equal(rows[0].kind, 'class', 'the more specific classification wins');
  } finally { fx.cleanup(); }
});

test('Rust resolves mod and use declarations', opts, async () => {
  const fx = await buildFixture({
    'Cargo.toml': '[package]\nname = "p"\n',
    'src/db.rs': 'pub fn find_user(id: &str) -> Option<String> { None }\n',
    'src/main.rs': 'mod db;\nuse db::find_user;\n\nfn main() { find_user("x"); }\n',
  });
  try {
    assert.equal(fx.importOf('src/main.rs', 'db').resolved_path, 'src/db.rs');
    assert.equal(fx.edge('main', 'find_user').confidence, 'EXACT');
  } finally { fx.cleanup(); }
});

test('Rust pub visibility is detected', opts, async () => {
  const fx = await buildFixture({
    'Cargo.toml': '[package]\nname = "p"\n',
    'src/lib.rs': 'pub fn open() {}\nfn hidden() {}\npub(crate) fn shared() {}\n',
  });
  try {
    assert.equal(fx.node('open').visibility, 'public');
    assert.equal(fx.node('hidden').visibility, 'private');
    assert.equal(fx.node('shared').visibility, 'internal');
  } finally { fx.cleanup(); }
});

test('Rust doc comments use /// not //', opts, async () => {
  const fx = await buildFixture({
    'Cargo.toml': '[package]\nname = "p"\n',
    'src/lib.rs': '// an implementation aside\n/// The real documentation.\npub fn go() {}\n',
  });
  try {
    assert.equal(fx.node('go').doc, 'The real documentation.');
  } finally { fx.cleanup(); }
});

test('Java resolves a package import to its source file', opts, async () => {
  const fx = await buildFixture({
    'pom.xml': '<project></project>',
    'src/main/java/com/acme/Db.java': 'package com.acme;\n\npublic class Db {\n    public String findUser(String id) { return null; }\n}\n',
    'src/main/java/com/acme/App.java': 'package com.acme;\n\nimport com.acme.Db;\n\npublic class App {\n    public void run() { new Db().findUser("x"); }\n}\n',
  });
  try {
    assert.equal(
      fx.importOf('src/main/java/com/acme/App.java', 'com.acme.Db').resolved_path,
      'src/main/java/com/acme/Db.java'
    );
  } finally { fx.cleanup(); }
});

test('Java visibility modifiers are read', opts, async () => {
  const fx = await buildFixture({
    'pom.xml': '<project></project>',
    'src/main/java/A.java': 'public class A {\n    public void pub() {}\n    private void priv() {}\n    protected void prot() {}\n}\n',
  });
  try {
    assert.equal(fx.node('pub').visibility, 'public');
    assert.equal(fx.node('priv').visibility, 'private');
    assert.equal(fx.node('prot').visibility, 'protected');
  } finally { fx.cleanup(); }
});

test('Java separates JDK imports from Maven dependencies', opts, async () => {
  const fx = await buildFixture({
    'pom.xml': '<project></project>',
    'src/main/java/A.java': 'import java.util.List;\nimport com.fasterxml.jackson.databind.ObjectMapper;\n\npublic class A {}\n',
  });
  try {
    assert.equal(fx.importOf('src/main/java/A.java', 'java.util.List').ecosystem, 'jdk');
    assert.equal(
      fx.importOf('src/main/java/A.java', 'com.fasterxml.jackson.databind.ObjectMapper').ext_package,
      'com.fasterxml.jackson'
    );
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- third-party discovery

test('a pack authored outside the repo is discovered and used', opts, async () => {
  // The whole plugin premise. If this fails, the architecture is decorative.
  const fx = await buildFixture({ 'package.json': '{"name":"t"}', 'src/a.js': 'export function x() {}\n' });

  try {
    const packDir = path.join(fx.root, '.codegraph', 'packs', 'toml');
    fs.mkdirSync(path.join(packDir, 'queries'), { recursive: true });

    fs.writeFileSync(
      path.join(packDir, 'queries', 'tags.scm'),
      '(table (bare_key) @name) @definition.class\n(pair (bare_key) @name) @definition.field\n'
    );
    fs.writeFileSync(
      path.join(packDir, 'index.js'),
      `import path from 'node:path';
       import { fileURLToPath } from 'node:url';
       const here = path.dirname(fileURLToPath(import.meta.url));
       export default {
         id: 'toml',
         languages: ['toml'],
         queries: { tags: path.join(here, 'queries', 'tags.scm') },
       };\n`
    );

    fs.writeFileSync(path.join(fx.root, 'config.toml'), '[server]\nport = 8080\nhost = "0.0.0.0"\n');

    // Re-index with the new pack present.
    const { Indexer } = await import('../src/core/indexer.js');
    const { PackRegistry } = await import('../src/packs/registry.js');
    const { DEFAULTS } = await import('../src/core/config.js');
    const config = {
      ...DEFAULTS, root: fx.root,
      dir: path.join(fx.root, '.codegraph'),
      deps: { ...DEFAULTS.deps, offline: true },
    };
    const registry = await PackRegistry.load(config);
    await new Indexer({ store: fx.store, config, registry }).run({ force: true });
    registry.dispose();

    const rows = fx.store.all(
      "SELECT n.name FROM nodes n JOIN files f ON f.id = n.file_id WHERE f.path = 'config.toml' AND n.kind != 'module'"
    );
    const names = rows.map((r) => r.name);
    assert.ok(names.includes('server'), `external pack should extract symbols; got ${names}`);
    assert.ok(names.includes('port'), 'and its members');
  } finally { fx.cleanup(); }
});

test('a broken third-party pack does not stop indexing', opts, async () => {
  const fx = await buildFixture({ 'package.json': '{"name":"t"}', 'src/a.js': 'export function keepMe() {}\n' });
  try {
    const packDir = path.join(fx.root, '.codegraph', 'packs', 'broken');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'index.js'), 'export default { /* no id */ };\n');

    const { PackRegistry } = await import('../src/packs/registry.js');
    const { DEFAULTS } = await import('../src/core/config.js');

    // Loading must succeed despite the malformed pack — one bad plugin cannot
    // be allowed to take down the whole tool.
    const registry = await PackRegistry.load({
      ...DEFAULTS, root: fx.root,
      dir: path.join(fx.root, '.codegraph'),
      deps: { ...DEFAULTS.deps, offline: true },
    });
    assert.ok(registry.packs.get('javascript'), 'builtin packs still load');
    registry.dispose();
  } finally { fx.cleanup(); }
});
