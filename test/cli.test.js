/**
 * End-to-end CLI tests.
 *
 * These run the real binary against a real repo. They are the only tests that
 * would catch a broken command registration, a bad import path in a lazily
 * loaded module, or output that crashes on an empty result — all of which are
 * invisible to unit tests and immediately visible to a user.
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

const REPO = {
  'package.json': '{"name":"demo","dependencies":{"ignore":"^7.0.0"}}',
  'src/db.js': `
/** Finds a user by id. */
export function findUser(id) { return { id }; }
export function saveUser(user) { return user; }
`,
  'src/auth.js': `
import { findUser } from './db';

/** Authenticates a user. */
export function handleLogin(email) {
  return findUser(email);
}
`,
  'src/api.js': `
import { handleLogin } from './auth';
import ignore from 'ignore';

export function postLogin(req) { return handleLogin(req.email); }

// An actual external call, so dependency-usage output has something to report.
export function makeFilter() { return ignore().add('node_modules'); }
`,
};

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-cli-'));
  for (const [rel, content] of Object.entries(REPO)) {
    const abs = path.join(root, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  run(root, ['index', '--quiet']);
  return root;
}

function run(root, args) {
  return execFileSync(process.execPath, [BIN, ...args, '--root', root], {
    encoding: 'utf8', cwd: root,
    env: { ...process.env, NO_COLOR: '1', CGRAPH_HOME: path.join(root, '.cache') },
  });
}

function runExpectingFailure(root, args) {
  try {
    run(root, args);
    return null;
  } catch (err) {
    return (err.stderr ?? '') + (err.stdout ?? '');
  }
}

test('--help lists the commands', () => {
  const output = execFileSync(process.execPath, [BIN, '--help'], {
    encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
  for (const cmd of ['init', 'index', 'map', 'find', 'read', 'graph', 'docs', 'serve']) {
    assert.match(output, new RegExp(`\\b${cmd}\\b`), `help should mention '${cmd}'`);
  }
});

test('an unknown command fails with a useful message', () => {
  let output = '';
  try {
    execFileSync(process.execPath, [BIN, 'nonsense'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    output = err.stderr;
  }
  assert.match(output, /Unknown command/);
  assert.match(output, /--help/);
});

test('map outlines a file with line numbers', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['map', 'src/auth.js']);
    assert.match(output, /src\/auth\.js/);
    assert.match(output, /handleLogin/);
    assert.match(output, /\d+ f/, 'symbols carry a line number and a kind marker');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('map reports its own token cost', opts, () => {
  // A measured response size, not a savings claim. cgraph deliberately does not
  // assert what some other workflow would have spent, because that number is
  // determined by the assumption rather than by any measurement.
  const root = setup();
  try {
    const output = run(root, ['map']);
    assert.match(output, /src\//);
    assert.match(output, /~\d+ tokens/, 'the response states what it cost');
    assert.ok(!/saved/i.test(output), 'must not claim a saving');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('find locates a symbol by a camelCase part', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['find', 'login']);
    assert.match(output, /handleLogin/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('find on no matches explains rather than printing nothing', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['find', 'zzzznotarealsymbol']);
    assert.match(output, /no symbols matching/i);
    assert.match(output, /update/, 'a stale index is the most common cause');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('read returns one symbol, including its export keyword', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['read', 'findUser']);
    assert.match(output, /export function findUser/,
      'the printed line must match the line number beside it');
    assert.ok(!output.includes('saveUser'), 'only the requested symbol');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('read accepts a path:line-range', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['read', 'src/db.js:2-3']);
    assert.match(output, /src\/db\.js:2-3/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('read of a missing symbol fails with guidance', opts, () => {
  const root = setup();
  try {
    const output = runExpectingFailure(root, ['read', 'nothingHere']);
    assert.match(output, /No symbol/);
    assert.match(output, /find/, 'point at the tool that would help');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('graph shows callers', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['graph', 'findUser']);
    assert.match(output, /handleLogin/);
    assert.match(output, /callers:/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('graph impact walks transitively', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['graph', 'findUser', '--dir', 'impact']);
    assert.match(output, /handleLogin/, 'direct caller');
    assert.match(output, /postLogin/, 'transitive caller');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('graph path traces a route between symbols', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['graph', 'postLogin', '--dir', 'path', 'findUser']);
    assert.match(output, /hops/);
    assert.match(output, /handleLogin/, 'the intermediate step is shown');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('graph rejects an unknown direction', opts, () => {
  const root = setup();
  try {
    const output = runExpectingFailure(root, ['graph', 'findUser', '--dir', 'sideways']);
    assert.match(output, /unknown --dir/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a symbol with no callers says so instead of printing nothing', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['graph', 'saveUser']);
    assert.match(output, /no callers/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('doctor reports resolution quality', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['doctor']);
    assert.match(output, /resolution quality/);
    assert.match(output, /proven/);
    assert.match(output, /javascript/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('stats reports measured query cost, not a savings multiplier', opts, () => {
  const root = setup();
  try {
    run(root, ['map']);
    run(root, ['find', 'user']);
    const output = run(root, ['stats']);
    assert.match(output, /query cost/);
    assert.match(output, /returned/);
    // Guards against the multiplier creeping back in: it required assuming what
    // a grep-driven session would have spent, which is not something this tool
    // can observe.
    assert.ok(!/reduction|saved|\dx/i.test(output), `stats must not claim savings:
${output}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('packs list shows which languages extract symbols', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['packs', 'list']);
    assert.match(output, /javascript/);
    assert.match(output, /symbols \+ edges/);
    assert.match(output, /languages extract symbols/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('packs scaffold generates a loadable pack', opts, () => {
  const root = setup();
  try {
    run(root, ['packs', 'scaffold', 'ruby']);
    const dir = path.join(root, '.cgraph', 'packs', 'ruby');
    assert.ok(fs.existsSync(path.join(dir, 'index.js')));
    assert.ok(fs.existsSync(path.join(dir, 'queries', 'tags.scm')));

    // The generated pack must be valid JS that the registry can import.
    const source = fs.readFileSync(path.join(dir, 'index.js'), 'utf8');
    assert.match(source, /export default/);
    assert.match(source, /id: 'ruby'/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('packs scaffold refuses an unknown grammar', opts, () => {
  const root = setup();
  try {
    const output = runExpectingFailure(root, ['packs', 'scaffold', 'klingon']);
    assert.match(output, /No grammar named/);
    assert.match(output, /--grammar/, 'offer the escape hatch');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('update after an edit reflects the change', opts, () => {
  const root = setup();
  try {
    fs.appendFileSync(
      path.join(root, 'src', 'db.js'),
      '\nexport function brandNewFunction() { return 42; }\n'
    );
    run(root, ['update', '--quiet']);
    const output = run(root, ['read', 'brandNewFunction']);
    assert.match(output, /brandNewFunction/);
    assert.match(output, /42/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('deleting a file removes its symbols', opts, () => {
  const root = setup();
  try {
    fs.rmSync(path.join(root, 'src', 'api.js'));
    run(root, ['update', '--quiet']);
    const output = runExpectingFailure(root, ['read', 'postLogin']);
    assert.match(output, /No symbol/, 'a deleted symbol must not linger in the index');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('--json produces parseable output', opts, () => {
  const root = setup();
  try {
    for (const args of [['find', 'user', '--json'], ['stats', '--json'], ['doctor', '--json']]) {
      const output = run(root, args);
      assert.doesNotThrow(() => JSON.parse(output), `${args[0]} --json must be valid JSON`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('budget truncates loudly rather than silently', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['read', 'findUser', '--budget', '12']);
    assert.match(output, /more lines/, 'truncation must be announced');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('commands fail clearly when no index exists', opts, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-noidx-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');
    const output = runExpectingFailure(root, ['find', 'anything']);
    assert.match(output, /cgraph init/, 'tell the user how to fix it');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('docs lists dependencies by usage', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['docs']);
    assert.match(output, /dependencies by usage/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
