/**
 * C# pack, technology discovery, and .NET dependency documentation.
 *
 * C# differs from the other packs in a way worth pinning: a `using` names a
 * *namespace*, which is declared across many files rather than located at a
 * path. Resolution therefore consults the index rather than the filesystem, and
 * that only works once the whole repo has been parsed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { buildFixture } from './fixture.js';
import { detectTechnologies, languagesToLoad } from '../src/packs/technologies.js';
import { parseXmlDoc } from '../src/deps/dotnet-xmldoc.js';

const require = createRequire(import.meta.url);
const skip = (() => {
  try { require.resolve('tree-sitter-wasms/package.json'); return false; }
  catch { return true; }
})();
const opts = { skip };

const CSPROJ = '<Project Sdk="Microsoft.NET.Sdk"></Project>';

// ---------------------------------------------------------------- extraction

test('extracts C# types, members and namespaces', opts, async () => {
  const fx = await buildFixture({
    'App.csproj': CSPROJ,
    'src/UserRepo.cs': `using System;

namespace MyApp.Data
{
    /// <summary>Reads and writes users.</summary>
    public class UserRepo : IUserRepo
    {
        public async Task<User> FindAsync(string email) { return null; }
        private void Log(string m) { }
        public string ConnectionString { get; set; }
        private readonly int _retries;
    }

    public interface IUserRepo { }
    public enum Status { Active }
    public record Dto(string Name);
    public struct Point { public int X; }
}
`,
  });
  try {
    const kinds = Object.fromEntries(
      fx.store.all("SELECT name, kind FROM nodes WHERE kind != 'module'").map((r) => [r.name, r.kind])
    );
    assert.equal(kinds.UserRepo, 'class');
    assert.equal(kinds.IUserRepo, 'interface');
    assert.equal(kinds.Status, 'enum');
    assert.equal(kinds.Dto, 'class', 'a record is a type');
    assert.equal(kinds.Point, 'class', 'a struct is a type');
    assert.equal(kinds.FindAsync, 'method');
    assert.equal(kinds.ConnectionString, 'field', 'properties are the C# public surface');
    assert.equal(kinds._retries, 'field');

    // variable_declarator holds a bare identifier with no `name:` field, unlike
    // every other declaration in this grammar — an easy pattern to get wrong.
    assert.ok(kinds._retries, 'field declarations must be extracted');
  } finally { fx.cleanup(); }
});

test('nests types inside their namespace', opts, async () => {
  const fx = await buildFixture({
    'App.csproj': CSPROJ,
    'src/A.cs': 'namespace MyApp.Services\n{\n    public class Svc { public void Go() {} }\n}\n',
  });
  try {
    const svc = fx.node('Svc');
    const parent = fx.store.get('SELECT name, kind FROM nodes WHERE id = ?', svc.parent_id);
    assert.equal(parent.name, 'MyApp.Services');
    assert.equal(parent.kind, 'module', 'a namespace is a real container');
  } finally { fx.cleanup(); }
});

test('captures signatures without folding in attributes', opts, async () => {
  const fx = await buildFixture({
    'App.csproj': CSPROJ,
    'src/A.cs': `namespace N
{
    public class C
    {
        [HttpPost]
        [Authorize]
        public async Task<bool> LoginAsync(string email, string pw) { return true; }
    }
}
`,
  });
  try {
    const sig = fx.node('LoginAsync').signature;
    assert.match(sig, /LoginAsync\(string email, string pw\)/);
    assert.ok(!sig.includes('[HttpPost]'), 'attributes belong on their own lines, not in the signature');
  } finally { fx.cleanup(); }
});

test('extracts XML doc summaries and drops the markup', opts, async () => {
  const fx = await buildFixture({
    'App.csproj': CSPROJ,
    'src/A.cs': `namespace N
{
    public class C
    {
        /// <summary>
        /// Finds a <see cref="T:N.User"/> by identifier.
        /// </summary>
        /// <param name="id">The identifier.</param>
        public void Find(int id) { }
    }
}
`,
  });
  try {
    const doc = fx.node('Find').doc;
    assert.match(doc, /Finds a User by identifier/, 'cref renders as the type name');
    assert.ok(!doc.includes('<'), 'markup must be stripped');
    assert.ok(!doc.includes('identifier.</param>'), 'param tags are structure, not prose');
  } finally { fx.cleanup(); }
});

test('reads C# access modifiers, including defaults', opts, async () => {
  const fx = await buildFixture({
    'App.csproj': CSPROJ,
    'src/A.cs': `namespace N
{
    public class C
    {
        public void Pub() {}
        private void Priv() {}
        protected void Prot() {}
        internal void Intern() {}
        void Implicit() {}
    }
}
`,
  });
  try {
    assert.equal(fx.node('Pub').visibility, 'public');
    assert.equal(fx.node('Priv').visibility, 'private');
    assert.equal(fx.node('Prot').visibility, 'protected');
    assert.equal(fx.node('Intern').visibility, 'internal');
    assert.equal(fx.node('Implicit').visibility, 'private', 'C# members default to private');
  } finally { fx.cleanup(); }
});

test('a namespace has no access modifier', opts, async () => {
  // Reporting it as private would be actively wrong — a namespace is visible
  // everywhere — and would mislead any ranking that prefers public symbols.
  const fx = await buildFixture({
    'App.csproj': CSPROJ,
    'src/A.cs': 'namespace MyApp { public class C {} }\n',
  });
  try {
    const ns = fx.store.get("SELECT visibility FROM nodes WHERE name = 'MyApp'");
    assert.equal(ns.visibility, null);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- resolution

test('a using resolves to the file declaring that namespace', opts, async () => {
  const fx = await buildFixture({
    'App.csproj': CSPROJ,
    'src/Data/Repo.cs': 'namespace MyApp.Data { public class Repo { public void Find() {} } }\n',
    'src/Svc/Login.cs': 'using MyApp.Data;\nnamespace MyApp.Svc { public class Login { } }\n',
  });
  try {
    const imp = fx.importOf('src/Svc/Login.cs', 'MyApp.Data');
    assert.equal(imp.resolved_path, 'src/Data/Repo.cs',
      'a namespace is declared, not located — resolution must consult the index');
  } finally { fx.cleanup(); }
});

test('a using resolves through a declared parent namespace', opts, async () => {
  // C# namespaces nest, so `using A.B.C` in a repo declaring `A.B` should still
  // find something rather than being reported as an external package.
  const fx = await buildFixture({
    'App.csproj': CSPROJ,
    'src/Data.cs': 'namespace MyApp.Data { public class R {} }\n',
    'src/Use.cs': 'using MyApp.Data.Models;\nnamespace MyApp.Use { public class U {} }\n',
  });
  try {
    assert.equal(fx.importOf('src/Use.cs', 'MyApp.Data.Models').resolved_path, 'src/Data.cs');
  } finally { fx.cleanup(); }
});

test('framework namespaces are separated from NuGet packages', opts, async () => {
  const fx = await buildFixture({
    'App.csproj': CSPROJ,
    'src/A.cs': `using System.Text.Json;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json;
namespace N { public class C {} }
`,
  });
  try {
    assert.equal(fx.importOf('src/A.cs', 'System.Text.Json').ecosystem, 'dotnet');
    assert.equal(fx.importOf('src/A.cs', 'Microsoft.Extensions.Logging').ecosystem, 'dotnet');
    const third = fx.importOf('src/A.cs', 'Newtonsoft.Json');
    assert.equal(third.ecosystem, 'nuget');
    assert.equal(third.ext_package, 'Newtonsoft.Json');
  } finally { fx.cleanup(); }
});

test('LINQ and BCL calls are classified, not reported as unresolved', opts, async () => {
  // Unresolved LINQ alone would dominate the diagnostics of any modern C# repo
  // and make the resolution-quality number meaningless.
  const fx = await buildFixture({
    'App.csproj': CSPROJ,
    'src/A.cs': `using System;
namespace N
{
    public class C
    {
        public void M(List<int> xs)
        {
            var r = xs.Where(x => x > 1).Select(x => x).ToList();
            Console.WriteLine(r.Count);
        }
    }
}
`,
  });
  try {
    const unresolved = fx.store.all(
      "SELECT name FROM unresolved WHERE name IN ('Where','Select','ToList','WriteLine')"
    );
    assert.deepEqual(unresolved, [], 'runtime calls are not resolution failures');
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- discovery

test('detects a .NET project from its csproj', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-tech-'));
  try {
    fs.mkdirSync(path.join(root, 'src', 'Api'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'Api', 'Api.csproj'),
      '<Project Sdk="Microsoft.NET.Sdk.Web"><ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore" /></ItemGroup></Project>');

    const t = detectTechnologies(root);
    assert.ok(t.stacks.includes('dotnet'));
    assert.ok(t.languages.includes('csharp'));
    assert.ok(t.ecosystems.includes('nuget'));
    assert.ok(t.frameworks.includes('aspnet'));
    assert.ok(t.frameworks.includes('entity-framework'));
    assert.ok(t.evidence.dotnet[0].endsWith('Api.csproj'), 'detection must be explainable');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('detects Angular and React from nested manifests', () => {
  // In a monorepo the root manifest holds tooling while the framework lives in
  // web/package.json. Reading only the root reports an Angular app as plain
  // TypeScript.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-tech-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"root","devDependencies":{"typescript":"^5"}}');
    fs.mkdirSync(path.join(root, 'web'), { recursive: true });
    fs.writeFileSync(path.join(root, 'web', 'package.json'),
      '{"name":"web","dependencies":{"@angular/core":"^17"}}');
    fs.mkdirSync(path.join(root, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ui', 'package.json'),
      '{"name":"ui","dependencies":{"react":"^18"}}');

    const t = detectTechnologies(root);
    assert.ok(t.frameworks.includes('angular'), `expected angular, got ${t.frameworks}`);
    assert.ok(t.frameworks.includes('react'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('detects a polyglot repository', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-tech-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');
    fs.writeFileSync(path.join(root, 'pom.xml'), '<project><dependency>spring-boot</dependency></project>');
    fs.writeFileSync(path.join(root, 'requirements.txt'), 'fastapi\npytest\n');

    const t = detectTechnologies(root);
    assert.deepEqual(t.stacks.sort(), ['java', 'node', 'python']);
    assert.ok(t.frameworks.includes('spring'));
    assert.ok(t.frameworks.includes('fastapi'));
    assert.deepEqual(t.ecosystems.sort(), ['maven', 'npm', 'pypi']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a malformed manifest narrows detection rather than breaking it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-tech-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{ this is not json');
    const t = detectTechnologies(root);
    assert.ok(t.stacks.includes('node'), 'the manifest still proves the stack');
    assert.deepEqual(t.frameworks, [], 'but nothing can be read from it');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('extensions present are unioned with manifest detection', () => {
  // Discovery narrows what loads eagerly; it must never decide that a file on
  // disk should be ignored.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-tech-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');
    const { languages } = languagesToLoad(root, { extensionsPresent: ['python'] });
    assert.ok(languages.includes('javascript'), 'from the manifest');
    assert.ok(languages.includes('python'), 'from files actually present');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a Node project does not load the C# pack', opts, async () => {
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/a.js': 'export function f() {}\n',
  });
  try {
    assert.ok(fx.registry.packs.has('javascript'));
    assert.ok(!fx.registry.packs.has('csharp'), 'an unused pack should not load, nor fetch its grammar');
  } finally { fx.cleanup(); }
});

test('an unexpected language still gets its pack loaded on sight', opts, async () => {
  // A Node repo with a Python build script: discovery did not predict it, but
  // ignoring the file would make the graph lie by omission.
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/a.js': 'export function jsFn() {}\n',
    'scripts/build.py': 'def build_it():\n    return 1\n',
  });
  try {
    const py = fx.store.get("SELECT name FROM nodes WHERE name = 'build_it'");
    assert.ok(py, 'the unexpected language must still be extracted');
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- XML docs

test('parses .NET XML documentation into symbols', () => {
  const xml = `<?xml version="1.0"?>
<doc>
  <assembly><name>My.Lib</name></assembly>
  <members>
    <member name="T:My.Lib.Widget">
      <summary>A widget.</summary>
    </member>
    <member name="M:My.Lib.Widget.Resize(System.Int32,System.String)">
      <summary>Resizes the <see cref="T:My.Lib.Widget"/>.</summary>
    </member>
    <member name="P:My.Lib.Widget.Name">
      <summary>Gets the name.</summary>
    </member>
    <member name="M:My.Lib.Widget.#ctor(System.String)">
      <summary>Creates one.</summary>
    </member>
  </members>
</doc>`;

  const { assembly, symbols } = parseXmlDoc(xml);
  assert.equal(assembly, 'My.Lib');

  const by = Object.fromEntries(symbols.map((s) => [s.symbol, s]));
  assert.equal(by.Widget.kind, 'class');
  assert.equal(by.Widget.doc, 'A widget.');

  assert.equal(by['Widget.Resize'].kind, 'method');
  assert.equal(by['Widget.Resize'].signature, 'Widget.Resize(int, string)',
    'BCL type names are aliased to their C# keywords');
  assert.equal(by['Widget.Resize'].doc, 'Resizes the Widget.', 'cref renders as a name');

  assert.equal(by['Widget.Name'].kind, 'field', 'a property is what a caller binds to');
});

test('XML doc parsing strips generic arity markers', () => {
  const xml = `<doc><members>
    <member name="M:N.Cache\`1.Get\`\`1(\`\`0)"><summary>Gets it.</summary></member>
  </members></doc>`;
  const { symbols } = parseXmlDoc(xml);
  assert.ok(symbols.length > 0);
  assert.ok(!symbols[0].symbol.includes('`'), `arity markers must go: ${symbols[0].symbol}`);
});

test('XML doc parsing caps output', () => {
  const members = Array.from({ length: 900 }, (_, i) =>
    `<member name="M:N.T.M${i}"><summary>Doc ${i}.</summary></member>`).join('');
  const { symbols } = parseXmlDoc(`<doc><members>${members}</members></doc>`, { limit: 50 });
  assert.equal(symbols.length, 50, 'a framework package has thousands nobody reads');
});

test('XML doc parsing survives malformed input', () => {
  for (const bad of ['', '<doc>', 'not xml at all', '<doc><members><member/></members></doc>']) {
    assert.doesNotThrow(() => parseXmlDoc(bad));
  }
});
