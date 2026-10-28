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
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildFixture } from './fixture.js';
import { definePack, validatePack, makeTestContext, CAPTURES } from '../src/sdk/index.js';
import { LANGUAGES, detectLanguage, languageById } from '../src/packs/languages.js';
import { detectTechnologies, languagesToLoad, detectSubprojectTechnologies } from '../src/packs/technologies.js';
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

// 'yaml' is excluded: its bundled grammar fails to parse under the pinned
// web-tree-sitter version (see the comment in src/packs/yaml/index.js), so
// it is not registered in BUILTIN either.
const BUILTIN_IDS = ['typescript', 'javascript', 'python', 'go', 'rust', 'java',
  'json', 'css', 'html', 'bash'];

test('every builtin pack passes its own validation', opts, async () => {
  for (const id of BUILTIN_IDS) {
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
    for (const id of BUILTIN_IDS) {
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

// ---------------------------------------------------------------- config & markup packs

test('JSON keys become nested symbols', opts, async () => {
  const fx = await buildFixture({
    'package.json': JSON.stringify({ name: 'x', scripts: { build: 'tsc', test: 'vitest' } }, null, 2),
  });
  try {
    assert.equal(fx.node('scripts').kind, 'key');
    const build = fx.node('build');
    assert.equal(build.kind, 'key');
    assert.equal(build.qname, 'package.json::scripts.build');
  } finally { fx.cleanup(); }
});

test('CSS rules are keyed by selector, keyframes by name', opts, async () => {
  const fx = await buildFixture({
    'app.css': '.btn, .btn-primary {\n  color: red;\n}\n\n@keyframes spin {\n  from { opacity: 0; }\n  to { opacity: 1; }\n}\n',
  });
  try {
    assert.equal(fx.node('.btn, .btn-primary').kind, 'rule');
    assert.equal(fx.node('spin').kind, 'rule');
  } finally { fx.cleanup(); }
});

test('HTML surfaces landmark tags, script/style blocks, and ided elements', opts, async () => {
  const fx = await buildFixture({
    'index.html': '<html><head><title>x</title></head><body>\n'
      + '  <nav id="main-nav"></nav>\n'
      + '  <div id="app"></div>\n'
      + '  <script>console.log(1)</script>\n'
      + '</body></html>\n',
  });
  try {
    const rows = fx.store.all(
      "SELECT name, kind FROM nodes n JOIN files f ON f.id = n.file_id WHERE f.path = 'index.html' AND kind != 'module'"
    );
    const names = rows.map((r) => r.name);
    assert.ok(names.includes('html'), 'landmark tag');
    assert.ok(names.includes('script'), 'script block, a distinct node type from element');
    assert.ok(names.includes('main-nav'), 'id attribute value');
    assert.ok(names.includes('app'), 'id attribute value');
    assert.ok(!names.includes('title'), 'non-landmark, id-less tags stay out to avoid DOM-wide noise');
  } finally { fx.cleanup(); }
});

test('Bash extracts function definitions and resolves calls between them', opts, async () => {
  const fx = await buildFixture({
    'deploy.sh': '#!/bin/bash\nfunction build() {\n  echo "building"\n}\n\ndeploy() {\n  build\n  echo "deployed"\n}\n',
  });
  try {
    assert.equal(fx.node('build').kind, 'function');
    assert.equal(fx.node('deploy').kind, 'function');
    assert.equal(fx.edge('deploy', 'build')?.kind, 'call');
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- strict mode

test('a stray file in an undetected language is lazy-loaded by default', opts, async () => {
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/a.js': 'export function x() {}\n',
    'tools/build.py': 'def helper():\n    pass\n',
  });
  try {
    assert.equal(fx.node('helper').kind, 'function');
  } finally { fx.cleanup(); }
});

test('packs.strict suppresses that fallback: the file is a stub, not parsed', opts, async () => {
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/a.js': 'export function x() {}\n',
    'tools/build.py': 'def helper():\n    pass\n',
  }, { packs: { strict: true } });
  try {
    assert.throws(() => fx.node('helper'), /no node named/);
    // The detected stack's own pack still loads normally — strict only turns
    // off the fallback for languages detection gave no signal for.
    assert.equal(fx.node('x').kind, 'function');

    const row = fx.store.get("SELECT parsed FROM files WHERE path = 'tools/build.py'");
    assert.equal(row.parsed, 0, 'file is still indexed as a stub, just unparsed');
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- third-party discovery

test('a pack authored outside the repo is discovered and used', opts, async () => {
  // The whole plugin premise. If this fails, the architecture is decorative.
  const fx = await buildFixture({ 'package.json': '{"name":"t"}', 'src/a.js': 'export function x() {}\n' });

  try {
    const packDir = path.join(fx.root, '.cgraph', 'packs', 'toml');
    fs.mkdirSync(path.join(packDir, 'queries'), { recursive: true });

    // Matches what `cgraph packs scaffold` writes: without the ESM marker Node
    // warns on every load.
    fs.writeFileSync(
      path.join(packDir, 'package.json'),
      JSON.stringify({ name: 'cgraph-pack-toml', version: '0.1.0', type: 'module', private: true })
    );

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
      dir: path.join(fx.root, '.cgraph'),
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
    const packDir = path.join(fx.root, '.cgraph', 'packs', 'broken');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'index.js'), 'export default { /* no id */ };\n');
    // Well-formed as a module; the fault under test is the missing `id`, and a
    // module-type warning would obscure that.
    fs.writeFileSync(
      path.join(packDir, 'package.json'),
      JSON.stringify({ name: 'cgraph-pack-broken', version: '0.1.0', type: 'module', private: true })
    );

    const { PackRegistry } = await import('../src/packs/registry.js');
    const { DEFAULTS } = await import('../src/core/config.js');

    // Loading must succeed despite the malformed pack — one bad plugin cannot
    // be allowed to take down the whole tool.
    const registry = await PackRegistry.load({
      ...DEFAULTS, root: fx.root,
      dir: path.join(fx.root, '.cgraph'),
      deps: { ...DEFAULTS.deps, offline: true },
    });
    assert.ok(registry.packs.get('javascript'), 'builtin packs still load');
    registry.dispose();
  } finally { fx.cleanup(); }
});

// ------------------------------------------------------- pack hook branches
//
// Each test below drives one hook branch through the REAL pipeline: a real
// source file, parsed with the real grammar, resolved by the real resolver. The
// assertion is what the hook produced in the graph, not what it returns when
// called in isolation — a hook that works alone but is wired to the wrong
// capture is exactly the defect a unit test cannot see.

test('Rust resolves crate:: paths and classifies std:: as rust-std', opts, async () => {
  // resolveImport: the `crate`/`self`/`super` branch (internal path) and the
  // `std`/`core`/`alloc` builtin branch. Both are the head=== segments tests.
  const fx = await buildFixture({
    'Cargo.toml': '[package]\nname = "p"\n',
    'src/db.rs': 'pub fn find_user(_id: &str) -> Option<String> { None }\n',
    'src/main.rs': 'use crate::db::find_user;\nuse std::vec::Vec;\n\nfn main() { find_user("x"); }\n',
  });
  try {
    // crate::db::find_user -> src/db.rs (matchModule strips the trailing symbol).
    assert.equal(fx.importOf('src/main.rs', 'crate::db').resolved_path, 'src/db.rs');
    assert.equal(fx.edge('main', 'find_user').confidence, 'EXACT');
    // std::vec -> external rust-std, package "std".
    const imp = fx.importOf('src/main.rs', 'std::vec');
    assert.equal(imp.ecosystem, 'rust-std');
    assert.equal(imp.ext_package, 'std');
  } finally { fx.cleanup(); }
});

test('Java package-private visibility and annotation-stripped signature', opts, async () => {
  // visibility(): the package-private default (no modifier -> internal).
  // signature(): the `@\w+` strip that keeps @Override/@Transactional out of
  // the signature.
  const fx = await buildFixture({
    'pom.xml': '<project></project>',
    'src/main/java/A.java':
      'class A {\n    void pkg() {}\n    @Override\n    public String findUser() { return null; }\n}\n',
  });
  try {
    assert.equal(fx.node('pkg').visibility, 'internal', 'no modifier is package-private');
    const sig = fx.node('findUser').signature;
    assert.ok(sig.includes('findUser'), 'signature keeps the method');
    assert.ok(!sig.includes('Override'), 'the @Override annotation is stripped');
  } finally { fx.cleanup(); }
});

test('Python resolves `from . import x` and `from ..pkg import y`', opts, async () => {
  // resolveImport relative branch: dots==1 with an empty rest (the `rest ? ...`
  // false arm -> the package directory itself), and dots>1 (the pop-the-parents
  // loop) for a two-dot import.
  const fx = await buildFixture({
    'pyproject.toml': '[project]\nname = "t"\n',
    'app/__init__.py': 'def x():\n    pass\n',
    'app/pkg.py': 'def y():\n    pass\n',
    'app/sub/__init__.py': '',
    'app/sub/main.py': 'from . import x\nfrom ..pkg import y\n\ndef run():\n    return x(), y()\n',
  });
  try {
    assert.equal(fx.importOf('app/sub/main.py', '.').resolved_path, 'app/sub/__init__.py',
      'a bare `.` resolves to the package __init__');
    assert.equal(fx.importOf('app/sub/main.py', '..pkg').resolved_path, 'app/pkg.py',
      'two dots walk up one directory level');
  } finally { fx.cleanup(); }
});

test('Go classifies a predeclared builtin (len) on the call graph', opts, async () => {
  // _asBuiltin for the Go pack: `len` is in builtins.globals, so the call
  // becomes a builtin edge, not an unresolved reference.
  const fx = await buildFixture({
    'go.mod': 'module m\n',
    'a.go': 'package a\n\nfunc f(s []string) int {\n\treturn len(s)\n}\n',
  });
  try {
    const edges = fx.edgesFrom('f');
    const builtin = edges.find((e) => e.ext_package === 'go' && e.ecosystem === 'builtin');
    assert.ok(builtin, 'len(s) resolves to a builtin edge, not unresolved');

    const rows = fx.store.all("SELECT name FROM unresolved WHERE name = 'len'");
    assert.deepEqual(rows, [], 'a builtin is not a resolution failure');
  } finally { fx.cleanup(); }
});

test('C# namespace nesting, default visibility, and attribute-stripped signature', opts, async () => {
  // visibility(): namespace -> null; a type with no modifier -> internal; a
  // member with no modifier -> private. signature(): the `[...]` strip that
  // keeps [HttpGet]/[Authorize] out of the rendered signature.
  const fx = await buildFixture({
    'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
    'src/Models.cs':
      'namespace App.Models\n{\n' +
      '    public class Widget\n    {\n' +
      '        [HttpGet]\n        [Authorize]\n        public string Render() { return Serialize(); }\n' +
      '        int counter = 0;\n' +
      '        string Serialize() { return ""; }\n' +
      '    }\n}\n',
  });
  try {
    assert.equal(fx.node('App.Models').kind, 'module', 'a namespace is a container node');
    assert.equal(fx.node('App.Models').visibility, null, 'a namespace is visible everywhere');
    assert.equal(fx.node('Widget').visibility, 'public');
    assert.equal(fx.node('counter').visibility, 'private', 'C# members default to private');
    assert.equal(fx.node('Serialize').visibility, 'private');
    const sig = fx.node('Render').signature;
    assert.ok(sig.includes('Render'));
    assert.ok(!sig.includes('HttpGet'), '[HttpGet] is folded out of the signature');
    assert.ok(!sig.includes('Authorize'));
  } finally { fx.cleanup(); }
});

test('C# resolves a using to the file that declares the namespace, and System.* to dotnet', opts, async () => {
  // resolveImport(): the findNamespace hit (a repo-declared namespace -> a file)
  // and the System/Microsoft external branch (ecosystem dotnet, two-segment
  // package).
  const fx = await buildFixture({
    'App.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
    'src/Models.cs': 'using System.Text;\nusing Newtonsoft.Json;\n\nnamespace App.Models\n{\n    public class Widget\n    {\n        public string Render() { return ""; }\n    }\n}\n',
    'src/Consumer.cs': 'using App.Models;\n\npublic class Consumer\n{\n    public void Go() { var w = new Widget(); w.Render(); }\n}\n',
  });
  try {
    assert.equal(fx.importOf('src/Consumer.cs', 'App.Models').resolved_path, 'src/Models.cs',
      'using App.Models binds to the declaring file via findNamespace');
    const sys = fx.importOf('src/Models.cs', 'System.Text');
    assert.equal(sys.ecosystem, 'dotnet');
    assert.equal(sys.ext_package, 'System.Text', 'System packages keep two segments');
    const np = fx.importOf('src/Models.cs', 'Newtonsoft.Json');
    assert.equal(np.ecosystem, 'nuget');
    assert.equal(np.ext_package, 'Newtonsoft.Json');
  } finally { fx.cleanup(); }
});

// ------------------------------------------------- registry: edge-case packs

test('a pack whose query file is missing is reported as a gap, not a crash', opts, async () => {
  // queriesFor(): the readFileSync try/catch (a declared query at a path that
  // does not exist). The language is then skipped as "no-queries" and surfaced
  // via gaps() / fingerprint(), not thrown.
  const fx = await buildFixture({ 'package.json': '{"name":"t"}', 'src/a.js': 'export function keepMe() {}\n' });
  try {
    const packDir = path.join(fx.root, '.cgraph', 'packs', 'toml');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(
      path.join(packDir, 'package.json'),
      JSON.stringify({ name: 'cgraph-pack-toml', version: '0.1.0', type: 'module', private: true })
    );
    fs.writeFileSync(
      path.join(packDir, 'index.js'),
      `import path from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst here = path.dirname(fileURLToPath(import.meta.url));\nexport default { id: 'toml', languages: ['toml'], queries: { tags: path.join(here, 'queries', 'nope.scm') } };\n`
    );
    fs.writeFileSync(path.join(fx.root, 'config.toml'), '[server]\nport = 1\n');

    const { Indexer } = await import('../src/core/indexer.js');
    const { PackRegistry } = await import('../src/packs/registry.js');
    const { DEFAULTS } = await import('../src/core/config.js');
    const config = { ...DEFAULTS, root: fx.root, dir: path.join(fx.root, '.cgraph'), deps: { ...DEFAULTS.deps, offline: true } };
    const registry = await PackRegistry.load(config);
    await new Indexer({ store: fx.store, config, registry }).run({ force: true });

    // The declared query could not be read, so toml has no tags -> a gap, and
    // fingerprint falls back to "missing" for it.
    assert.ok(registry.gaps().includes('toml'), 'gaps() reports a query-less language');
    assert.ok(registry.fingerprint(), 'fingerprint() tolerates the missing query file');

    const rows = fx.store.all(
      "SELECT n.name FROM nodes n JOIN files f ON f.id = n.file_id WHERE f.path = 'config.toml' AND n.kind != 'module'"
    );
    assert.deepEqual(rows, [], 'the file is indexed as a stub: no symbols extracted');

    registry.dispose();
  } finally { fx.cleanup(); }
});

test('a pack module with no default export object is skipped, not fatal', opts, async () => {
  // importPack(): the `!pack || typeof pack !== 'object'` throw, caught by
  // load()'s per-source try/catch. A module that exports nothing useful must
  // not take indexing down.
  const fx = await buildFixture({ 'package.json': '{"name":"t"}', 'src/a.js': 'export function keepMe() {}\n' });
  try {
    const packDir = path.join(fx.root, '.cgraph', 'packs', 'noexport');
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(
      path.join(packDir, 'package.json'),
      JSON.stringify({ name: 'cgraph-pack-noexport', version: '0.1.0', type: 'module', private: true })
    );
    fs.writeFileSync(path.join(packDir, 'index.js'), 'export const notAPack = { id: "x" };\n');

    const { PackRegistry } = await import('../src/packs/registry.js');
    const { DEFAULTS } = await import('../src/core/config.js');
    const registry = await PackRegistry.load({
      ...DEFAULTS, root: fx.root, dir: path.join(fx.root, '.cgraph'),
      deps: { ...DEFAULTS.deps, offline: true },
    });
    assert.ok(registry.packs.get('javascript'), 'builtins survive a malformed external pack');
    assert.ok(!registry.packs.get('x'), 'the malformed module contributed no pack');
    registry.dispose();
  } finally { fx.cleanup(); }
});

// ------------------------------------------------ technologies: detection

// These drive technologies.js directly against a temp directory. No grammars are
// needed — detection reads manifests only — so they are not gated on `opts`.

function tempTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-tech-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

test('detection finds a manifest at depth 3 and unions node frameworks', () => {
  // shallowPaths maxDepth=3: apps/web/package.json is reached; the node
  // frameworks fn scans EVERY package.json (not just root) for react, so a
  // monorepo app is reported as React, not plain node.
  const root = tempTree({
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { react: '^18.0.0' } }),
  });
  try {
    const t = detectTechnologies(root);
    assert.ok(t.stacks.includes('node'), 'node manifest detected at depth 3');
    assert.ok(t.languages.includes('typescript') && t.languages.includes('javascript'));
    assert.ok(t.frameworks.includes('react'), 'framework read from the nested manifest');
    // evidence records the manifest *file name* (basename) that proved the stack.
    assert.ok(t.evidence.node.includes('package.json'), 'evidence names the proving manifest');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a malformed manifest narrows detection without breaking it', () => {
  // readJson(): the JSON.parse catch returns null; the node frameworks fn then
  // `continue`s on a null package, so detection still records the stack from the
  // file name, reports no frameworks, and never throws.
  const root = tempTree({ 'package.json': '{ this is not valid json' });
  try {
    const t = detectTechnologies(root);
    assert.ok(t.stacks.includes('node'), 'the stack is detected from the file name');
    assert.deepEqual(t.frameworks, [], 'a malformed manifest yields no frameworks, no crash');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('languagesToLoad unions present extensions over manifest languages', () => {
  // languagesToLoad(): manifest languages (node -> js/ts/tsx) unioned with
  // extensionsPresent (a stray Go file), so discovery narrows eager loading
  // without ever excluding a language that has files on disk.
  const root = tempTree({ 'package.json': '{"name":"t"}' });
  try {
    const r = languagesToLoad(root, { extensionsPresent: ['go'] });
    assert.ok(r.languages.includes('javascript') && r.languages.includes('typescript'));
    assert.ok(r.languages.includes('go'), 'extension-present language is unioned in');
    assert.equal(r.technologies.stacks.includes('node'), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('detectSubprojectTechnologies scopes detection to each nested repo', () => {
  // detectSubprojectTechnologies(): runs detectTechnologies per subproject dir,
  // keyed by the boundary path the walker recorded.
  const root = tempTree({
    'svc1/go.mod': 'module svc1\n',
    'svc2/Cargo.toml': '[package]\nname = "s2"\n',
  });
  try {
    const out = detectSubprojectTechnologies(root, ['svc1', 'svc2']);
    assert.ok(out['svc1'].stacks.includes('go'));
    assert.ok(out['svc2'].stacks.includes('rust'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
