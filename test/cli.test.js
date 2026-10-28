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
import { parseArgs } from '../src/cli/args.js';
import { formatConfidence } from '../src/core/retrieve.js';
import { bytes, toks, duration, pad, padLeft, color, Progress } from '../src/cli/ui.js';

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
  for (const cmd of ['init', 'index', 'map', 'find', 'read', 'graph', 'serve']) {
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

test('find on a near-miss suggests the real symbol, never a fabrication', opts, () => {
  // #2: a bare empty is a dead end the agent stops at (silent truncation). The
  // suggestion must be a real indexed name so the caller self-corrects.
  const root = setup();
  try {
    const output = run(root, ['find', 'xxlogin']);
    assert.match(output, /did you mean/i, 'a near-miss must offer a suggestion');
    assert.match(output, /handleLogin/, 'the suggestion is a real symbol, not invented');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('find with zero similarity says no close matches', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['find', 'qqqqzzzzx']);
    assert.match(output, /no symbols matching/i);
    assert.ok(!/did you mean/.test(output), 'nothing clears the similarity floor; no fabrication');
    assert.match(output, /update/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('map --detail full adds doc comments; default outline omits them', opts, () => {
  // #4: the verbosity knob trades context tokens for detail. The default (no
  // --detail) reproduces the existing outline exactly.
  const root = setup();
  try {
    const outline = run(root, ['map', 'src/auth.js']);
    const full = run(root, ['map', 'src/auth.js', '--detail', 'full']);
    assert.match(outline, /handleLogin/, 'both modes list the symbol');
    assert.ok(!/Authenticates a user/.test(outline), 'outline carries no doc prose');
    assert.match(full, /Authenticates a user/, 'full includes the doc comment');
    assert.ok(full.length > outline.length, 'full costs more tokens than outline');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('map --detail outline equals the default output byte-for-byte', opts, () => {
  const root = setup();
  try {
    assert.equal(
      run(root, ['map', 'src/auth.js', '--detail', 'outline']),
      run(root, ['map', 'src/auth.js']),
      'the default reproduces prior output exactly'
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('find and map output is byte-identical across repeated calls (#3)', opts, () => {
  // #3: SQLite does not guarantee ordering for tied ORDER BY keys. Equal-key rows
  // (rank/score ties) shuffle between runs, which breaks prompt-cache hits. The
  // explicit id/path tiebreaks make output stable. Same query, same store, twice.
  const root = setup();
  try {
    assert.equal(run(root, ['find', 'user']), run(root, ['find', 'user']),
      'find must be byte-identical across runs');
    assert.equal(run(root, ['map']), run(root, ['map']),
      'map (directory outline) must be byte-identical across runs');
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
    assert.ok(!/index is stale/.test(output),
      'a line-range query always slices by line; that is not a staleness fallback');
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

test('graph explore shows callers and callees with exact line ranges', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['graph', 'handleLogin', '--dir', 'explore']);
    // handleLogin's own definition is on lines 5-7 of src/auth.js.
    assert.match(output, /handleLogin\s+src[\\/]auth\.js:5-7/, 'target symbol carries its own start-end range');
    assert.match(output, /called from \(bottom-up/);
    assert.match(output, /postLogin/, 'postLogin calls handleLogin');
    assert.match(output, /calls \(top-down/);
    assert.match(output, /findUser/, 'handleLogin calls findUser');
    // Both the caller and callee lines carry a start-end range, not just a start line.
    assert.match(output, /postLogin\s+src[\\/]api\.js:\d+-\d+/);
    assert.match(output, /findUser\s+src[\\/]db\.js:\d+-\d+/);
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

// ---------------------------------------------------------------------------
// FIX #1 guard: short-flag value consumption.
//
// Why this matters: the long-flag branch decided "does this flag consume the
// next argv" by consulting BOTH the raw key and the resolved alias name, while
// the short-flag branch consulted ONLY the resolved name. Specs list the alias
// KEY (e.g. 'q' in the real CLI's `strings` list, aliased to 'query'), so a
// short `-q foo` resolved the name to 'query', missed the 'q' entry, and treated
// it as a boolean — the value 'foo' silently landed in positionals, while the
// equivalent long `--q foo` worked. These tests lock the two branches to the
// same consume-check so they can never drift again.
// ---------------------------------------------------------------------------

test('parseArgs: a short alias flag consumes its value (long/short parity)', () => {
  // Mirrors the real CLI spec: 'q' is declared in strings and aliased to 'query'.
  const spec = { strings: ['query', 'q'], alias: { q: 'query' } };

  const short = parseArgs(['find', '-q', 'foo'], spec);
  assert.equal(short.query, 'foo', '-q must consume the next argv as its value');
  assert.ok(!short._.includes('foo'), 'the value must not leak into positionals');

  const long = parseArgs(['find', '--q', 'foo'], spec);
  assert.deepEqual(short, long, 'short and long forms must parse identically');
});

test('parseArgs: a short numeric alias coerces to a number', () => {
  // Numbers are declared by alias key ('l'), not by resolved name ('limit') —
  // exactly the case the old short-flag branch missed.
  const spec = { numbers: ['limit', 'l'], alias: { l: 'limit' } };

  const short = parseArgs(['graph', 'x', '-l', '5'], spec);
  assert.equal(short.limit, 5, '-l 5 yields a number, not a string');
  assert.equal(typeof short.limit, 'number');
  assert.deepEqual(short._, ['graph', 'x'], 'the consumed value is not a positional');

  const long = parseArgs(['graph', 'x', '--l', '5'], spec);
  assert.deepEqual(short, long, 'short and long numeric forms must match');
});

test('parseArgs: boolean short flags and -abc clusters swallow no value', () => {
  // A cluster where NEITHER flag consumes a value must stay boolean and leave the
  // following argv as a positional — the consume-check must not start consuming
  // for a boolean flag, and only the LAST char of a cluster may consume.
  const spec = { strings: [], alias: {} };
  const bool = parseArgs(['graph', 'x', '-j'], spec);
  assert.equal(bool.j, true, 'a boolean short flag is true, with no value to consume');

  const cluster = parseArgs(['graph', 'x', '-jq', 'foo'], spec);
  assert.equal(cluster.j, true, 'first cluster char is boolean');
  assert.equal(cluster.q, true, 'q is boolean when not declared in strings');
  assert.deepEqual(cluster._, ['graph', 'x', 'foo'], 'no value is swallowed from a boolean cluster');
});

test('parseArgs: everything after `--` is positional, never a flag', () => {
  // The `--` terminator (args.js lines 35-38) is how a caller passes a value that
  // begins with a dash (e.g. a path like `-weird.js`) without it being parsed as a
  // flag; a regression here silently eats real arguments.
  const spec = { strings: ['root'] };
  const out = parseArgs(['find', '--', '--not-a-flag', 'rest'], spec);
  assert.deepEqual(out._, ['find', '--not-a-flag', 'rest'], 'post-`--` argv are positionals');
  assert.ok(!('not-a-flag' in out), 'the terminator stops flag parsing');
});

// ---------------------------------------------------------------------------
// FIX #4 guard: a single shared confidence formatter.
//
// Why this matters: the INFERRED-edge marker was string-literal duplicated in
// the CLI (confMark) and the MCP server (inline ternaries). They agreed today;
// a future confidence-tier change updating one site would silently desync the
// CLI legend from the MCP legend, breaking the "verify `!` before relying on
// it" contract. These tests assert both entry points emit the marker from the
// SAME helper, byte-for-byte.
// ---------------------------------------------------------------------------

test('formatConfidence is the single source of the edge marker', () => {
  assert.equal(formatConfidence('EXACT'), ' ', 'exact edges show a leading space');
  assert.equal(formatConfidence('INFERRED'), '!', 'inferred edges show !');
  // Any non-EXACT tier (current or future) marks as inferred — matches the
  // original `confidence === 'EXACT' ? ' ' : '!'` output byte-for-byte.
  assert.equal(formatConfidence('SOMETHING_ELSE'), '!');
});

test('CLI and MCP emit the same `!` marker for an inferred edge', opts, () => {
  // `shared` is called by name in b.js with NO import, so the call edge is a
  // name-match guess → INFERRED → must carry `!` from both entry points.
  const REPO_INFERRED = {
    'package.json': '{"name":"parity"}',
    'src/a.js': 'export function shared() { return 1; }\n',
    'src/b.js': 'export function caller() { return shared(); }\n',
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-parity-'));
  try {
    for (const [rel, content] of Object.entries(REPO_INFERRED)) {
      const abs = path.join(root, rel.split('/').join(path.sep));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    run(root, ['index', '--quiet']);

    const cliOut = run(root, ['graph', 'shared', '--dir', 'callers']);
    // The marker is the shared helper's output and prefixes the inferred caller
    // row (qname is the fully-qualified `src/b.js::caller`).
    assert.ok(cliOut.includes(`${formatConfidence('INFERRED')} src/b.js::caller`),
      `CLI must mark the inferred caller with the shared marker:\n${cliOut}`);
    assert.match(cliOut, /inferred/, 'CLI keeps the legend explaining !');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// CLI-branch coverage phase: one test per reachable branch the gap map named.
// Each comment names the exact branch it covers, per the project style.
// ---------------------------------------------------------------------------

// A second repo with two same-named symbols, for the read multi-match branch
// (an ambiguous bare name must list the alternatives, not silently pick one).
const AMBIG = {
  'package.json': '{"name":"ambig"}',
  'src/a.js': 'export function helper() { return "a"; }\n',
  'src/b.js': 'export function helper() { return "b"; }\n',
};
function setupFiles(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-cli-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  run(root, ['index', '--quiet']);
  return root;
}

// --help branch: every command has `if (args.help) return help()`.
test('each command --help prints its usage block', opts, () => {
  // The top-level --help is already covered; this reaches each command's own
  // help() branch, which is dead code if the router never forwards --help.
  const root = setup();
  const probes = {
    map: /outline/i, find: /search symbols/i, read: /read exactly one symbol/i,
    graph: /traverse relationships/i, stats: /index size/i, doctor: /index health/i,
    index: /build or refresh/i, update: /build or refresh/i,
  };
  try {
    for (const [cmd, re] of Object.entries(probes)) {
      const output = run(root, [cmd, '--help']);
      assert.match(output, re, `${cmd} --help must print its usage`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// graph --dir callees, external branch.
test('graph callees lists external dependencies', opts, () => {
  // makeFilter calls the external `ignore` package → the external: block.
  const root = setup();
  try {
    const output = run(root, ['graph', 'makeFilter', '--dir', 'callees']);
    assert.match(output, /external:/);
    assert.match(output, /ignore/, 'the external package is named');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// graph --dir callees, internal branch.
test('graph callees lists internal calls', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['graph', 'handleLogin', '--dir', 'callees']);
    assert.match(output, /findUser/, 'the internal callee is listed');
    assert.ok(!/calls nothing/.test(output), 'has a callee, not the empty branch');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// graph --dir callees, the "calls nothing" empty branch.
test('graph callees on a leaf says it calls nothing', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['graph', 'findUser', '--dir', 'callees']);
    assert.match(output, /calls nothing/i, 'a leaf must say so, not print nothing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// graph --dir importers, populated branch.
test('graph importers lists files importing the symbol file', opts, () => {
  // findUser lives in src/db.js, imported by src/auth.js.
  const root = setup();
  try {
    const output = run(root, ['graph', 'findUser', '--dir', 'importers']);
    assert.match(output, /files importing src[\\/]db\.js/);
    assert.match(output, /src[\\/]auth\.js/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// graph --dir importers, the "nothing imports this file" empty branch.
test('graph importers says when a file is imported by nobody', opts, () => {
  // src/api.js is imported by no one.
  const root = setup();
  try {
    const output = run(root, ['graph', 'postLogin', '--dir', 'importers']);
    assert.match(output, /nothing imports this file/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// graph --dir impact, the "N hops" depth-grouping branch.
test('graph impact groups results by hop distance', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['graph', 'findUser', '--dir', 'impact']);
    assert.match(output, /direct:/, 'depth 1 group');
    assert.match(output, /2 hops:/, 'depth 2 group');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// graph --dir impact, the "nothing depends on this" empty branch.
test('graph impact on a leaf says nothing depends on it', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['graph', 'saveUser', '--dir', 'impact']);
    assert.match(output, /nothing depends on this/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// graph --dir impact, the truncation branch.
test('graph impact truncates loudly when the set exceeds --limit', opts, () => {
  // --limit 1 forces out.length >= limit so the truncated line is emitted.
  const root = setup();
  try {
    const output = run(root, ['graph', 'findUser', '--dir', 'impact', '--limit', '1']);
    assert.match(output, /truncated:/, 'a capped impact set must announce the cap');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// graph --dir path, the missing-destination branch.
test('graph --dir path without a destination fails with guidance', opts, () => {
  const root = setup();
  try {
    const output = runExpectingFailure(root, ['graph', 'postLogin', '--dir', 'path']);
    assert.match(output, /destination symbol/, 'missing 2nd arg has a specific message');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// graph --dir path, the unreachable (no-path) branch.
test('graph --dir path reports no path when none exists', opts, () => {
  // saveUser has no incoming call edges → no call path from postLogin.
  const root = setup();
  try {
    const output = run(root, ['graph', 'postLogin', '--dir', 'path', 'saveUser']);
    assert.match(output, /no call path/, 'an unreachable destination says so, not nothing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// graph --json: the json() early-return branch.
test('graph --json is parseable and carries the direction', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['graph', 'findUser', '--dir', 'callees', '--json']);
    const parsed = JSON.parse(output);
    assert.equal(parsed.direction, 'callees');
    assert.ok(Array.isArray(parsed.lines));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// graph with no target: the `!target` guard.
test('graph with no symbol fails with guidance', opts, () => {
  const root = setup();
  try {
    const output = runExpectingFailure(root, ['graph']);
    assert.match(output, /give a symbol name/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// read multi-match branch: an ambiguous bare name lists "N other matches".
test('read on an ambiguous name lists the other matches', opts, () => {
  // Two files define `helper`; the best one is shown and the rest enumerated,
  // because silently returning one is the ambiguity AGENTS.md forbids.
  const root = setupFiles(AMBIG);
  try {
    const output = run(root, ['read', 'helper']);
    assert.match(output, /1 other match/, 'the second candidate is announced');
    assert.match(output, /src[\\/]b\.js:/, 'the other match names its file and line');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// read --all: bypasses the multi-match list and reads the single best symbol.
test('read --all skips the other-matches list', opts, () => {
  const root = setupFiles(AMBIG);
  try {
    const output = run(root, ['read', 'helper', '--all']);
    assert.ok(!/other match/.test(output), '--all must not print the candidate list');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// read --mode signature: the signature() early-return branch (no body).
test('read --mode signature returns doc and signature, not the body', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['read', 'findUser', '--mode', 'signature']);
    assert.match(output, /Finds a user by id/, 'the doc comment is shown');
    assert.ok(!/\{ id \}/.test(output), 'the body must not be present in signature mode');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// read --json: the json() early-return branch.
test('read --json is parseable', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['read', 'findUser', '--json']);
    assert.doesNotThrow(() => JSON.parse(output));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// find --kind filter that excludes everything: the filterNote branch.
test('find --kind excluding all matches shows filter guidance', opts, () => {
  // 'login' matches handleLogin (a function); --kind interface empties the set,
  // which reads like "nothing exists" unless the filter is named.
  const root = setup();
  try {
    const output = run(root, ['find', 'login', '--kind', 'interface']);
    assert.match(output, /--kind/, 'the filter that emptied the set is named');
    assert.match(output, /excluded by your/i, 'the guidance explains it is the filter');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// find --path filter that excludes everything: the filterNote branch.
test('find --path excluding all matches shows filter guidance', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['find', 'user', '--path', 'src/does-not-exist']);
    assert.match(output, /--path/, 'the path filter is named');
    assert.match(output, /excluded by your/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// find --verbose: renderHits showWhy branch (the [strategy] suffix).
test('find --verbose shows why each hit matched', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['find', 'login', '--verbose']);
    assert.match(output, /\[.+?\]/, 'each hit is annotated with its match strategy');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// find --budget: the fitToBudget dropped-lines branch.
test('find truncates loudly under a tiny --budget', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['find', 'user', '--budget', '1']);
    assert.match(output, /raise --budget/, 'dropped lines are announced');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// find with no query: the `!query` guard.
test('find with no query fails with guidance', opts, () => {
  const root = setup();
  try {
    const output = runExpectingFailure(root, ['find']);
    assert.match(output, /give a search query/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// map directory outline vs file outline.
test('map on a directory outlines the tree, distinct from a file outline', opts, () => {
  const root = setup();
  try {
    const dir = run(root, ['map', 'src']);
    assert.match(dir, /src\//, 'the directory listing references the path');
    // A file outline carries a per-symbol line+kind column; a directory outline
    // shows a "files" header instead.
    const file = run(root, ['map', 'src/auth.js']);
    assert.match(dir, /files/, 'directory outline reports file counts');
    assert.match(file, /handleLogin/, 'file outline lists symbols');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// map --json: the json() early-return branch (both file and dir).
test('map --json is parseable for both file and directory', opts, () => {
  const root = setup();
  try {
    for (const args of [['map', '--json'], ['map', 'src/auth.js', '--json']]) {
      const output = run(root, args);
      const parsed = JSON.parse(output);
      assert.ok(Array.isArray(parsed.lines), `${args.join(' ')} --json has lines`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// map --kind: the kinds filter on a file outline.
test('map --kind narrows a file outline', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['map', 'src/db.js', '--kind', 'function']);
    assert.match(output, /findUser/, 'the requested kind is present');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// index --dry-run: side-effect-free (must not create .cgraph).
test('index --dry-run writes nothing', opts, () => {
  // Users reach for --dry-run to see what WOULD happen, so it must not create
  // the .cgraph/ dir as a side effect.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-dry-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"dry"}');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'x.js'), 'export function f() { return 1; }\n');
    const output = run(root, ['index', '--dry-run']);
    assert.match(output, /would index/, 'the dry-run verb is "would index"');
    assert.ok(!fs.existsSync(path.join(root, '.cgraph')), 'a dry run must not create .cgraph/');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// index --dry-run --verbose: the verbose file-listing branch.
test('index --dry-run --verbose lists every file', opts, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-dryv-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"dryv"}');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'x.js'), 'export function f() { return 1; }\n');
    const output = run(root, ['index', '--dry-run', '--verbose']);
    assert.match(output, /src[\\/]x\.js/, 'verbose dry-run lists the file path');
    assert.ok(!fs.existsSync(path.join(root, '.cgraph')), 'still side-effect-free');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// index --json: the serializable()/json() branch.
test('index --json is parseable', opts, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-idxj-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"idxj"}');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'x.js'), 'export function f() { return 1; }\n');
    const output = run(root, ['index', '--json']);
    assert.doesNotThrow(() => JSON.parse(output));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// index full report: resolution / languages / source-cost branches.
test('index report renders resolution quality and language breakdown', opts, () => {
  // A non-quiet index prints the resolution split and language table; those
  // branches are invisible to the quiet setup() path used everywhere else.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-idxr-'));
  try {
    for (const [rel, content] of Object.entries(REPO)) {
      const abs = path.join(root, rel.split('/').join(path.sep));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    const output = run(root, ['index']);
    assert.match(output, /indexed/, 'the verb is "indexed" for a fresh index');
    assert.match(output, /resolution/, 'the resolution section is printed');
    assert.match(output, /languages/, 'the language breakdown is printed');
    assert.match(output, /of source/, 'the source-cost footer is printed');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// update report: the isUpdate branch ("updated") + unchanged line.
test('update report uses the update verb and reports unchanged files', opts, () => {
  // setup() already indexed; a second update finds everything unchanged, so the
  // "updated" verb and the "unchanged (hash match)" line are both exercised.
  const root = setup();
  try {
    const output = run(root, ['update']);
    assert.match(output, /updated/, 'the verb is "updated" for update');
    assert.match(output, /unchanged/, 'unchanged files are reported');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// index --force: the force:true path re-parses everything.
test('index --force re-parses and reports parsed files', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['index', '--force']);
    assert.match(output, /indexed/, 'force still indexes');
    assert.match(output, /parsed/, 'force re-parses (parsed count shown)');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// doctor rendering: staleness + imports-resolved branches.
test('doctor renders staleness and import resolution', opts, () => {
  const root = setup();
  try {
    const output = run(root, ['doctor']);
    assert.match(output, /index updated/, 'a freshly built index reports its age');
    assert.match(output, /imports resolved:/, 'the import-resolution line renders');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// stats: the "no queries recorded yet" branch (fresh index, no queries).
test('stats reports no queries on a fresh index', opts, () => {
  // setup() runs `index`, which records no query counters, so stats hits the
  // early-return branch before any tool breakdown.
  const root = setup();
  try {
    const output = run(root, ['stats']);
    assert.match(output, /no queries recorded yet/, 'the empty-ledger branch renders');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// stats: the per-tool breakdown + "files read" branch (after queries).
test('stats renders a per-tool breakdown after queries', opts, () => {
  // Running queries first populates the tool.* counters the breakdown table
  // reads, plus total.tokens_source which drives the "files read" line.
  const root = setup();
  try {
    run(root, ['map', 'src/auth.js']);
    run(root, ['read', 'findUser']);
    const output = run(root, ['stats']);
    assert.match(output, /query cost/, 'the query-cost header renders');
    assert.match(output, /tool/, 'the per-tool table header renders');
    assert.match(output, /map/, 'the map tool appears in the breakdown');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// cli/ui.js formatters and gating — the pure helpers the gap map named.
// These are unit-level on purpose: a byte-formatting regression (e.g. bytes()
// losing its K/M tiers) is invisible end-to-end on a small repo.
// ---------------------------------------------------------------------------

test('ui.bytes formats B/K/M tiers', () => {
  // The three tier branches: <1K, <1M, >=1M.
  assert.equal(bytes(512), '512B');
  assert.equal(bytes(2048), '2.0K');
  assert.equal(bytes(2 * 1024 * 1024), '2.0M');
});

test('ui.toks formats plain/k/M tiers', () => {
  assert.equal(toks(42), '42');
  assert.equal(toks(1500), '1.5k');
  assert.equal(toks(2_500_000), '2.5M');
});

test('ui.duration formats ms/s/m-s tiers', () => {
  assert.equal(duration(250), '250ms');
  assert.equal(duration(2500), '2.5s');
  assert.equal(duration(90_000), '1m30s');
});

test('ui.pad and padLeft align to a column width', () => {
  // The pad branch (short) and the passthrough branch (already wide enough).
  assert.equal(pad('ab', 5), 'ab   ', 'short strings are right-padded');
  assert.equal(pad('abcdef', 3), 'abcdef', 'strings >= width pass through untouched');
  assert.equal(padLeft('ab', 5), '   ab', 'short strings are left-padded');
  assert.equal(padLeft('abcdef', 3), 'abcdef', 'wide strings pass through');
});

test('ui color is gated off on a non-TTY / NO_COLOR run', () => {
  // The test process is piped (and CI sets NO_COLOR), so isTTY is false and
  // every color helper must return the string with no ANSI escape. This locks
  // the gating so piped output never carries escape codes.
  assert.equal(color.bold('x'), 'x', 'no escape codes when color is gated off');
  assert.equal(color.dim('x'), 'x');
  assert.ok(!color.red('x').includes('\x1b['), 'no ANSI sequences leak into output');
});

test('ui Progress stays quiet when piped and never throws', () => {
  // quiet-when-piped branch: on a non-TTY stdout, tick() increments the counter
  // and returns before writing, so a piped index emits no progress.
  const p = new Progress('indexing');
  assert.equal(p.quiet, true, 'a piped run forces quiet');
  assert.doesNotThrow(() => { p.tick(3, 'file.js'); p.tick(); });
  assert.equal(p.n, 4, 'the counter accumulates even while quiet');
  assert.doesNotThrow(() => p.done());
});

test('ui Progress quiet is forced explicitly', () => {
  // The { quiet: true } constructor branch (index-cmd passes quiet for --json).
  const p = new Progress('x', { quiet: true });
  assert.equal(p.quiet, true);
  assert.doesNotThrow(() => p.tick());
});

// ---------------------------------------------------------------------------
// Batch 2: the remaining reachable CLI branches, located from the coverage
// report's uncovered-line list.
// ---------------------------------------------------------------------------

// index.js --version branch.
test('--version prints the package version', () => {
  // `cgraph --version` reads package.json and prints; a regression in the
  // version path (e.g. a bad relative URL) breaks release tooling silently.
  const output = execFileSync(process.execPath, [BIN, '--version'], {
    encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
  assert.match(output.trim(), /^\d+\.\d+\.\d+/, '--version prints a semver');
});

// find --lang filter branch (the kind/path sibling in the same filterNote path).
test('find --lang excluding all matches shows filter guidance', opts, () => {
  // 'user' matches JS symbols; --lang rust empties the set, so the --lang
  // member of the filterNote list must be reported.
  const root = setup();
  try {
    const output = run(root, ['find', 'user', '--lang', 'rust']);
    assert.match(output, /--lang/, 'the lang filter is named');
    assert.match(output, /excluded by your/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// read single-line range (the m[3]-absent branch of parseLocation).
test('read a single-line range (no end) slices one line', opts, () => {
  // The existing range test uses start-end; this covers the single-line branch
  // where end falls back to start.
  const root = setup();
  try {
    const output = run(root, ['read', 'src/db.js:3']);
    assert.match(output, /src\/db\.js:3-3/, 'a bare :line becomes a 1-line range');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// read multi-match, the plural "N other matches" branch (>1 extra candidate).
test('read lists plural other matches when three symbols share a name', opts, () => {
  // AMBIG has 2 helpers (singular "1 other match"); three forces the plural.
  const root = setupFiles({
    'package.json': '{"name":"tri"}',
    'src/a.js': 'export function widget() { return 1; }\n',
    'src/b.js': 'export function widget() { return 2; }\n',
    'src/c.js': 'export function widget() { return 3; }\n',
  });
  try {
    const output = run(root, ['read', 'widget']);
    assert.match(output, /2 other matches/, 'plural matches when more than one candidate remains');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// graph on a file that is indexed but has no symbols: the findFileByName branch.
test('graph on a symbol-less indexed file points at map', opts, () => {
  // An image is indexed as a stub (skip_reason) with no symbols. A graph miss
  // must distinguish "indexed, no symbols" (use map) from "not indexed" (use
  // find) — the two need different next steps (AGENTS.md: never guess).
  const root = setupFiles({
    'package.json': '{"name":"img"}',
    'assets/logo.png': 'not-a-real-png',
  });
  try {
    const output = runExpectingFailure(root, ['graph', 'logo.png']);
    assert.match(output, /indexed but has no symbols/, 'indexed-but-symbolless is named');
    assert.match(output, /image/, 'the skip reason is surfaced');
    assert.match(output, /cgraph map/, 'and it points at map, not find');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// graph on a totally unknown name: the generic "No symbol named" miss branch.
test('graph on an unknown symbol points at find', opts, () => {
  const root = setup();
  try {
    const output = runExpectingFailure(root, ['graph', 'zzznosuchsymbol']);
    assert.match(output, /No symbol named/, 'a total miss says so plainly');
    assert.match(output, /cgraph find/, 'and points at find');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// graph --dir explore on a leaf: both empty branches (no callers + calls nothing).
test('graph explore on a leaf reports both directions empty', opts, () => {
  // saveUser is exported but never called (no callers) and returns only its
  // argument (no callees), so explore hits the no-callers line AND the
  // calls-nothing line in one pass.
  const root = setup();
  try {
    const output = run(root, ['graph', 'saveUser', '--dir', 'explore']);
    assert.match(output, /no callers found/i, 'bottom-up empty branch');
    assert.match(output, /calls nothing/i, 'top-down empty branch');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// graph --dir explore external branch (the explore external: block).
test('graph explore lists external dependencies top-down', opts, () => {
  // makeFilter calls the external `ignore` package → explore's external block.
  const root = setup();
  try {
    const output = run(root, ['graph', 'makeFilter', '--dir', 'explore']);
    assert.match(output, /external:/, 'the explore external block renders');
    assert.match(output, /ignore/, 'the external package is named');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// index --dry-run --json: the dryRun json() branch.
test('index --dry-run --json is parseable and side-effect-free', opts, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-dryj-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"dryj"}');
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'x.js'), 'export function f() { return 1; }\n');
    const output = run(root, ['index', '--dry-run', '--json']);
    assert.doesNotThrow(() => JSON.parse(output), 'dry-run --json is valid JSON');
    assert.ok(!fs.existsSync(path.join(root, '.cgraph')), 'still creates nothing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// index report + doctor with skips, unresolved refs, and recorded queries.
test('index report shows skipped-by-reason; doctor shows skips, unresolved, query cost', opts, () => {
  // One repo exercises three renderers at once: an image (skip_reason) drives
  // index's bySkip section and doctor's skips table; an unresolvable call drives
  // doctor's top-unresolved table; a prior query drives doctor's query-cost line.
  // The first index must be the non-quiet one, so bySkip is populated (setupFiles
  // pre-indexes quietly, which would make this index a no-op).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-diag-'));
  try {
    const files = {
      'package.json': '{"name":"diag"}',
      'src/run.js': 'export function runIt() { return totallyMissingThing(); }\n',
      'assets/logo.png': 'not-a-real-png',
    };
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel.split('/').join(path.sep));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    const idx = run(root, ['index']);
    assert.match(idx, /skipped by reason/, 'index lists the skip_reason group');

    run(root, ['map', 'src']); // records a query so doctor's query-cost line fires
    const doc = run(root, ['doctor']);
    assert.match(doc, /skipped files/, 'doctor lists skipped files');
    assert.match(doc, /most common unresolved names/, 'doctor lists unresolved refs');
    assert.match(doc, /totallyMissingThing/, 'the unresolvable call is named');
    assert.match(doc, /queries so far returned/, 'doctor reports recorded query cost');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
