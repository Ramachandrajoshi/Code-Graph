/**
 * Index freshness tests.
 *
 * Staleness is the failure mode that matters most in this tool: an agent acting
 * on a line number that has moved edits the wrong code, and nothing in the
 * output would tell it that happened. So the guarantee under test is that a
 * running MCP server never answers from a graph that disagrees with the working
 * tree — without a watcher, a hook, or the user remembering anything.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { walk } from '../src/core/walker.js';
import { DEFAULTS } from '../src/core/config.js';

const require = createRequire(import.meta.url);
const skip = (() => {
  try { require.resolve('tree-sitter-wasms/package.json'); return false; }
  catch { return true; }
})();
const opts = { skip };

const BIN = fileURLToPath(new URL('../bin/cgraph.js', import.meta.url));

function makeRepo(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-fresh-'));
  const files = {
    'package.json': '{"name":"demo"}',
    'src/a.js': 'export function alpha() { return 1; }\n',
    ...extra,
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function cli(root, args) {
  return execFileSync(process.execPath, [BIN, ...args, '--root', root], {
    encoding: 'utf8', cwd: root,
    env: { ...process.env, NO_COLOR: '1', CGRAPH_HOME: path.join(root, '.cache') },
  });
}

// ---------------------------------------------------------------- stat fast path

test('an unchanged file is never read during a refresh', () => {
  // The whole basis of affordable auto-refresh. If this regresses, every
  // freshness check reads every byte in the repository again.
  const root = makeRepo();
  try {
    const config = { ...DEFAULTS, ignore: [], root };
    const stats = new Map();
    for (const f of walk(root, config, { readContent: false })) {
      stats.set(f.rel, { size: f.size, mtime: f.mtime });
    }

    let read = 0;
    const seen = [];
    for (const f of walk(root, config, {
      isUnchanged: (rel, st) => {
        const prior = stats.get(rel);
        return !!prior && prior.size === st.size && prior.mtime === st.mtime;
      },
    })) {
      seen.push(f.rel);
      if (f.content !== undefined) read++;
    }

    assert.ok(seen.length > 0, 'files are still yielded');
    assert.equal(read, 0, 'no file contents should have been read');
    assert.ok(seen.every((r) => r), 'every file is still accounted for');
  } finally { cleanup(root); }
});

test('a changed file is still read despite the fast path', () => {
  const root = makeRepo();
  try {
    const config = { ...DEFAULTS, ignore: [], root };
    // Claim everything is unchanged except one file.
    const records = [...walk(root, config, {
      isUnchanged: (rel) => rel !== 'src/a.js',
    })];

    const changed = records.find((r) => r.rel === 'src/a.js');
    assert.ok(changed.content, 'the changed file must be read');
    assert.ok(changed.hash, 'and hashed');
    assert.ok(records.some((r) => r.unchanged), 'others take the fast path');
  } finally { cleanup(root); }
});

test('touching a file without editing it does not re-parse it', opts, () => {
  // The fast path falls through to the content hash, which is what keeps a
  // touched-but-identical file from being treated as changed.
  const root = makeRepo();
  try {
    cli(root, ['index', '--quiet']);
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(path.join(root, 'src', 'a.js'), future, future);

    const output = cli(root, ['update']);
    assert.match(output, /unchanged/, 'a touch must not count as a change');
    // Anchored: an unanchored /changed\s+\d/ also matches "unchanged   2".
    assert.ok(!/^\s*changed\s+[1-9]/m.test(output), `expected no changes, got:\n${output}`);
  } finally { cleanup(root); }
});

test('a real edit is detected', opts, () => {
  const root = makeRepo();
  try {
    cli(root, ['index', '--quiet']);
    fs.appendFileSync(path.join(root, 'src', 'a.js'), '\nexport function beta() { return 2; }\n');

    const output = cli(root, ['update']);
    assert.match(output, /changed\s+1/);
    assert.match(cli(root, ['find', 'beta']), /beta/);
  } finally { cleanup(root); }
});

// ---------------------------------------------------------------- auto refresh

/** Drive a long-lived server, performing `act()` between two queries. */
async function withServer(root, act) {
  const child = spawn(process.execPath, [BIN, 'serve', '--root', root], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CGRAPH_HOME: path.join(root, '.cache') },
  });

  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.resume();

  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
  await wait(700);

  await act(send);

  child.stdin.end();
  await new Promise((r) => child.on('close', r));

  return stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('a running server picks up a new file with no watcher or restart', opts, async () => {
  const root = makeRepo();
  try {
    cli(root, ['index', '--quiet']);

    const responses = await withServer(root, async (send) => {
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'find', arguments: { query: 'gamma' } } });
      await wait(600);

      // Created behind the server's back — no notification of any kind.
      fs.writeFileSync(path.join(root, 'src', 'b.js'), 'export function gammaRay() { return 3; }\n');
      await wait(3400);   // past the throttle window

      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'find', arguments: { query: 'gamma' } } });
      await wait(1500);
    });

    const before = responses.find((r) => r.id === 2).result.content[0].text;
    const after = responses.find((r) => r.id === 3).result.content[0].text;

    assert.match(before, /No symbols matching/);
    assert.match(after, /gammaRay/, 'the new symbol must appear without any explicit refresh');
  } finally { cleanup(root); }
});

test('a running server notices a deleted file', opts, async () => {
  const root = makeRepo({ 'src/doomed.js': 'export function doomedFn() { return 1; }\n' });
  try {
    cli(root, ['index', '--quiet']);

    const responses = await withServer(root, async (send) => {
      fs.rmSync(path.join(root, 'src', 'doomed.js'));
      await wait(3400);
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'find', arguments: { query: 'doomedFn' } } });
      await wait(1500);
    });

    const text = responses.find((r) => r.id === 2).result.content[0].text;
    assert.match(text, /No symbols matching/, 'a deleted symbol must not linger');
  } finally { cleanup(root); }
});

test('status refreshes immediately, ignoring the throttle', opts, async () => {
  const root = makeRepo();
  try {
    cli(root, ['index', '--quiet']);

    const responses = await withServer(root, async (send) => {
      // Query first so the throttle window is definitely open.
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'map', arguments: {} } });
      await wait(400);

      fs.writeFileSync(path.join(root, 'src', 'c.js'), 'export function deltaFn() { return 4; }\n');
      await wait(200);   // deliberately inside the throttle window

      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: {} } });
      await wait(1500);
      send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'find', arguments: { query: 'deltaFn' } } });
      await wait(800);
    });

    assert.match(responses.find((r) => r.id === 4).result.content[0].text, /deltaFn/,
      'an explicit status must bypass the throttle');
  } finally { cleanup(root); }
});

test('auto-refresh can be turned off', opts, async () => {
  const root = makeRepo();
  try {
    cli(root, ['index', '--quiet']);
    fs.writeFileSync(
      path.join(root, '.cgraph', 'config.json'),
      JSON.stringify({ autoRefresh: { enabled: false } })
    );

    const responses = await withServer(root, async (send) => {
      fs.writeFileSync(path.join(root, 'src', 'd.js'), 'export function epsilonFn() { return 5; }\n');
      await wait(3400);
      send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'find', arguments: { query: 'epsilonFn' } } });
      await wait(1200);
    });

    assert.match(responses.find((r) => r.id === 2).result.content[0].text, /No symbols matching/,
      'disabling auto-refresh must actually disable it');
  } finally { cleanup(root); }
});

// ---------------------------------------------------------------- git hooks

function gitRepo() {
  const root = makeRepo();
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

test('hooks install writes the pre-warm hooks', opts, () => {
  const root = gitRepo();
  try {
    cli(root, ['index', '--quiet']);
    cli(root, ['hooks', 'install']);

    for (const name of ['post-checkout', 'post-merge', 'post-rewrite']) {
      const text = fs.readFileSync(path.join(root, '.git', 'hooks', name), 'utf8');
      assert.match(text, /cgraph update/, `${name} should refresh`);
      assert.match(text, /&\)/, `${name} must be backgrounded so git is never delayed`);
    }
  } finally { cleanup(root); }
});

test('post-commit is excluded unless asked for', opts, () => {
  // Committing does not change the working tree, so the index is already
  // correct; adding latency to every commit would buy nothing.
  const root = gitRepo();
  try {
    cli(root, ['index', '--quiet']);
    cli(root, ['hooks', 'install']);
    assert.ok(!fs.existsSync(path.join(root, '.git', 'hooks', 'post-commit')));

    cli(root, ['hooks', 'install', '--all']);
    assert.ok(fs.existsSync(path.join(root, '.git', 'hooks', 'post-commit')));
  } finally { cleanup(root); }
});

test('an existing hook is appended to, never replaced', opts, () => {
  // Overwriting someone's hook destroys work that may not be recoverable.
  const root = gitRepo();
  try {
    const file = path.join(root, '.git', 'hooks', 'post-merge');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\necho "existing behaviour"\n');

    cli(root, ['index', '--quiet']);
    cli(root, ['hooks', 'install']);

    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /existing behaviour/, "the user's hook must survive");
    assert.match(text, /cgraph update/);
  } finally { cleanup(root); }
});

test('uninstall removes only our block', opts, () => {
  const root = gitRepo();
  try {
    const file = path.join(root, '.git', 'hooks', 'post-merge');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\necho "existing behaviour"\n');

    cli(root, ['index', '--quiet']);
    cli(root, ['hooks', 'install']);
    cli(root, ['hooks', 'uninstall']);

    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /existing behaviour/);
    assert.ok(!text.includes('cgraph update'), 'our block must be gone');

    // A hook that was ours alone is removed rather than left empty.
    assert.ok(!fs.existsSync(path.join(root, '.git', 'hooks', 'post-checkout')));
  } finally { cleanup(root); }
});

test('installing twice does not duplicate the block', opts, () => {
  const root = gitRepo();
  try {
    cli(root, ['index', '--quiet']);
    cli(root, ['hooks', 'install']);
    cli(root, ['hooks', 'install']);

    const text = fs.readFileSync(path.join(root, '.git', 'hooks', 'post-merge'), 'utf8');
    assert.equal((text.match(/cgraph update/g) ?? []).length, 1);
  } finally { cleanup(root); }
});

test('hooks outside a git repository fail with an explanation', opts, () => {
  const root = makeRepo();
  try {
    cli(root, ['index', '--quiet']);
    let output = '';
    try { cli(root, ['hooks', 'install']); }
    catch (err) { output = (err.stderr ?? '') + (err.stdout ?? ''); }
    assert.match(output, /not a git repository/);
    assert.match(output, /optional/, 'and should say hooks are not required');
  } finally { cleanup(root); }
});

test('hooks status reports what is installed', opts, () => {
  const root = gitRepo();
  try {
    cli(root, ['index', '--quiet']);
    assert.match(cli(root, ['hooks', 'status']), /post-checkout/);
    cli(root, ['hooks', 'install']);
    assert.match(cli(root, ['hooks', 'status']), /yes\s+post-checkout/);
  } finally { cleanup(root); }
});
