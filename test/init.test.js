/**
 * `init` tests.
 *
 * init is the only command that writes outside .cgraph/, so it is held to a
 * stricter standard: never clobber a config it did not create, never destroy a
 * file it cannot parse, and never create directories for tools the project does
 * not use. A tool that silently rewrites a developer's editor config loses
 * trust permanently and does not get it back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const skip = (() => {
  try { require.resolve('tree-sitter-wasms/package.json'); return false; }
  catch { return true; }
})();
const opts = { skip };

const BIN = fileURLToPath(new URL('../bin/cgraph.js', import.meta.url));

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-init-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function init(root, extra = []) {
  return execFileSync(process.execPath, [BIN, 'init', '--root', root, '--quiet', ...extra], {
    encoding: 'utf8', cwd: root,
  });
}

const BASE = {
  'package.json': '{"name":"demo"}',
  'src/a.js': 'export function alpha() { return 1; }\n',
};

test('creates the index and a config file', opts, () => {
  const root = makeRepo(BASE);
  try {
    init(root);
    assert.ok(fs.existsSync(path.join(root, '.cgraph', 'index.db')), 'index created');
    assert.ok(fs.existsSync(path.join(root, '.cgraph', 'config.json')), 'config created');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('registers an MCP server in .mcp.json', opts, () => {
  const root = makeRepo(BASE);
  try {
    init(root);
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    assert.ok(mcp.mcpServers['cgraph'], 'server registered');
    assert.equal(mcp.mcpServers['cgraph'].command, 'cgraph');
    assert.ok(mcp.mcpServers['cgraph'].args.includes('serve'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('preserves existing servers when registering', opts, () => {
  const root = makeRepo({
    ...BASE,
    '.mcp.json': JSON.stringify({ mcpServers: { other: { command: 'other-tool' } } }, null, 2),
  });
  try {
    init(root);
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    assert.ok(mcp.mcpServers.other, 'an unrelated server must survive');
    assert.equal(mcp.mcpServers.other.command, 'other-tool');
    assert.ok(mcp.mcpServers['cgraph']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('does not overwrite an existing cgraph entry', opts, () => {
  // The user may have customised the command or args; init must not stomp it.
  const root = makeRepo({
    ...BASE,
    '.mcp.json': JSON.stringify({
      mcpServers: { 'cgraph': { command: 'custom-path/cgraph', args: ['serve'] } },
    }, null, 2),
  });
  try {
    init(root);
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    assert.equal(mcp.mcpServers['cgraph'].command, 'custom-path/cgraph', 'customisation preserved');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('leaves an unparseable config untouched', opts, () => {
  // Destroying a file we cannot read is the worst possible outcome — it may hold
  // settings for tools that have nothing to do with us.
  const broken = '{ this is not valid json at all';
  const root = makeRepo({ ...BASE, '.mcp.json': broken });
  try {
    init(root);
    assert.equal(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'), broken, 'file untouched');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('writes to .cursor/mcp.json only when that directory exists', opts, () => {
  const withCursor = makeRepo({ ...BASE, '.cursor/settings.json': '{}' });
  const without = makeRepo(BASE);
  try {
    init(withCursor);
    assert.ok(fs.existsSync(path.join(withCursor, '.cursor', 'mcp.json')), 'registers when Cursor is in use');

    init(without);
    assert.ok(!fs.existsSync(path.join(without, '.cursor')), 'does not create dirs for unused tools');
  } finally {
    fs.rmSync(withCursor, { recursive: true, force: true });
    fs.rmSync(without, { recursive: true, force: true });
  }
});

test('--no-mcp skips all agent registration', opts, () => {
  const root = makeRepo(BASE);
  try {
    init(root, ['--no-mcp']);
    assert.ok(!fs.existsSync(path.join(root, '.mcp.json')));
    assert.ok(fs.existsSync(path.join(root, '.cgraph', 'index.db')), 'still indexes');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('adds .cgraph/ to an existing .gitignore', opts, () => {
  const root = makeRepo({ ...BASE, '.gitignore': 'node_modules/\n', '.git/config': '' });
  try {
    init(root);
    const text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.match(text, /^\.cgraph\/$/m);
    assert.match(text, /node_modules\//, 'existing rules preserved');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('does not duplicate an existing .cgraph entry', opts, () => {
  const root = makeRepo({ ...BASE, '.gitignore': '.cgraph/\n', '.git/config': '' });
  try {
    init(root);
    init(root);
    const text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.equal((text.match(/\.cgraph/g) ?? []).length, 1, 'idempotent');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('does not create a .gitignore in a non-git directory', opts, () => {
  const root = makeRepo(BASE);
  try {
    init(root);
    assert.ok(!fs.existsSync(path.join(root, '.gitignore')), 'no git, no gitignore');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('running init twice is safe', opts, () => {
  const root = makeRepo(BASE);
  try {
    init(root);
    const first = fs.readFileSync(path.join(root, '.mcp.json'), 'utf8');
    init(root);
    assert.equal(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'), first);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('reports language coverage gaps during init', opts, () => {
  // A user whose main language has no queries should learn it immediately, not
  // by wondering later why find returns nothing.
  //
  // Ruby is used here precisely because it has a grammar but no pack yet. If a
  // Ruby pack is added later this test will fail — swap it for whichever
  // language is still uncovered, and treat the failure as good news.
  const root = makeRepo({ ...BASE, 'app.rb': "def hello\n  puts 'hi'\nend\n" });
  try {
    const output = init(root);
    assert.match(output, /no extraction queries yet/);
    assert.match(output, /ruby/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
