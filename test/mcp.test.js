/**
 * MCP server tests.
 *
 * Protocol bugs are unusually costly here: a malformed frame or a stray stdout
 * write produces a server that connects and then silently does nothing, with no
 * error anywhere the user can see. These tests drive the real server over a
 * real pipe.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildFixture } from './fixture.js';
import { toolDefinitions } from '../src/mcp/tools.js';
import { estimate } from '../src/core/tokens.js';
import { formatConfidence } from '../src/core/retrieve.js';

const require = createRequire(import.meta.url);
const skip = (() => {
  try { require.resolve('tree-sitter-wasms/package.json'); return false; }
  catch { return true; }
})();
const opts = { skip };

const BIN = fileURLToPath(new URL('../bin/cgraph.js', import.meta.url));
const PROTOCOL = fileURLToPath(new URL('../src/mcp/protocol.js', import.meta.url));

/**
 * Drive the server over stdio and collect responses.
 * Uses the real binary rather than importing the handler, so framing and
 * stdout-purity are actually exercised.
 */
function session(root, messages, { timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'serve', '--root', root], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server timed out.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeout);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('close', () => {
      clearTimeout(timer);
      const responses = stdout.trim().split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); }
        catch { throw new Error(`non-JSON on stdout (corrupts the protocol): ${line}`); }
      });
      resolve({ responses, stderr, stdout });
    });

    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
    child.stdin.end();
  });
}

/**
 * Raw variant of `session`: the caller supplies the exact stdin writes (strings,
 * partial lines, batched frames), so framing edges — chunk splits, blank lines —
 * can be driven directly.
 */
function rawSession(root, writes, { timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'serve', '--root', root], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server timed out.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeout);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('close', () => {
      clearTimeout(timer);
      const responses = stdout.trim().split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); }
        catch { throw new Error(`non-JSON on stdout (corrupts the protocol): ${line}`); }
      });
      resolve({ responses, stderr, stdout });
    });

    for (const w of writes) child.stdin.write(w);
    child.stdin.end();
  });
}

/** One tools/call round trip; returns the tool result object. */
async function toolCall(root, name, args, id = 2) {
  const { responses } = await session(root, [
    INIT,
    { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
  ]);
  return responses.find((r) => r.id === id).result;
}

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};

const REPO = {
  'package.json': '{"name":"t"}',
  'src/db.js': 'export function findUser(id) { return id; }\n',
  'src/app.js': "import { findUser } from './db';\nexport function handleLogin(email) { return findUser(email); }\n",
};

// One symbol, no edges: drives the every-direction "empty" branches.
const ONE = {
  'package.json': '{"name":"t"}',
  'src/leaf.js': 'export function leaf() { return 1; }\n',
};

// Two unconnected symbols: drives the no-call-path branch of direction="path".
const ISLANDS = {
  'package.json': '{"name":"t"}',
  'src/one.js': 'export function one() { return 1; }\n',
  'src/two.js': 'export function two() { return 2; }\n',
};

// A bare-specifier import with no node_modules: the external-package edge,
// the same pattern test/resolve.test.js treats as canonical.
const EXT = {
  'package.json': '{"name":"t"}',
  'src/app.js': "import express from 'express';\nexport function boot() { return express(); }\n",
};

// Two calls to one symbol on the SAME line: sites > 1, the `(2x)` suffix.
const TWICE = {
  'package.json': '{"name":"t"}',
  'src/db.js': 'export function findUser(id) { return id; }\n',
  'src/app.js': "import { findUser } from './db';\nexport function handleLogin(a, b) { findUser(a); return findUser(b); }\n",
};

// A hub with 40 callers: a relationship set big enough that an explicit
// budget must truncate it.
const HUB = {
  'package.json': '{"name":"t"}',
  'src/hub.js': 'export function hub() { return 1; }\n',
  'src/apps.js': Array.from({ length: 40 }, (_, i) =>
    `import { hub } from './hub';\nexport function c${i}() { return hub(); }`).join('\n') + '\n',
};

// A 250-deep call chain: impact() has a hard limit of 200, so the closure
// of fn0 must report `(truncated — this symbol is central)`.
const CHAIN_N = 250;
const CHAIN = {
  'package.json': '{"name":"chain"}',
  'src/chain.js': Array.from({ length: CHAIN_N }, (_, i) =>
    i === CHAIN_N - 1
      ? 'export function fn0() { return 1; }'
      : `export function fn${CHAIN_N - 1 - i}() { return fn${CHAIN_N - 2 - i}(); }`).join('\n') + '\n',
};

test('tool schemas stay within their token budget', () => {
  // Guards against description creep. Every token here is paid on every turn of
  // every conversation, forever.
  const tokens = estimate(JSON.stringify(toolDefinitions({})));
  assert.ok(tokens < 1400, `tool schemas cost ${tokens} tokens; budget is 1400`);
});

test('map exposes a small detail enum and stays under the budget gate', () => {
  // #4: the context-aware verbosity knob. The enum must stay 2 values (schema
  // tokens are a permanent per-turn tax), and adding it must not break the
  // 1400-token gate the suite enforces.
  const map = toolDefinitions({}).find((t) => t.name === 'map');
  const detail = map.inputSchema.properties.detail;
  assert.ok(detail, 'map must expose a `detail` param');
  assert.deepEqual(detail.enum, ['outline', 'full'], 'the enum stays 2 values to bound schema cost');
  assert.ok(estimate(JSON.stringify(toolDefinitions({}))) < 1400, 'detail addition must keep the gate green');
});

test('the budget estimator does not under-bill non-ASCII responses', () => {
  // The MCP budget gate above is only meaningful if estimate() is honest. It
  // previously billed every non-ASCII codepoint with the ASCII chars/3.6
  // divisor, so a CJK-heavy response (common in non-English codebases) was
  // under-counted ~3.3x: budgets that looked satisfied were over the real cap.
  assert.ok(estimate('字'.repeat(40)) > 30, 'CJK must bill near-per-glyph, not on 3.6');
  // The tool schemas are ASCII JSON, so the budget gate itself is unaffected —
  // ASCII estimates must be byte-identical to the prior heuristic.
  assert.equal(estimate('a'.repeat(40)), 12, 'ASCII estimate must not regress');
});

test('exposes exactly the intended tool set', () => {
  const names = toolDefinitions({}).map((t) => t.name);
  assert.deepEqual(names, ['map', 'find']);
});

test('similar is registered only when embeddings are enabled', () => {
  assert.ok(!toolDefinitions({}).some((t) => t.name === 'similar'));
  assert.ok(toolDefinitions({ embeddingsEnabled: true }).some((t) => t.name === 'similar'));
});

test('every tool declares a valid JSON Schema', () => {
  for (const tool of toolDefinitions({ embeddingsEnabled: true })) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} schema must be an object`);
    assert.ok(tool.description?.length > 20, `${tool.name} needs a usable description`);
    for (const req of tool.inputSchema.required ?? []) {
      assert.ok(
        tool.inputSchema.properties[req],
        `${tool.name} requires '${req}' but does not define it`
      );
    }
  }
});

test('initialize returns server info and a negotiated protocol version', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [INIT]);
    const init = responses.find((r) => r.id === 1);
    assert.equal(init.result.serverInfo.name, 'cgraph');
    assert.equal(init.result.protocolVersion, '2025-06-18', 'should echo a version we speak');
    assert.ok(init.result.capabilities.tools);
  } finally { fx.cleanup(); }
});

test('falls back to a known protocol version for an unknown request', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [
      { ...INIT, params: { ...INIT.params, protocolVersion: '1999-01-01' } },
    ]);
    assert.ok(
      ['2025-06-18', '2025-03-26', '2024-11-05'].includes(responses[0].result.protocolVersion)
    );
  } finally { fx.cleanup(); }
});

test('notifications receive no response', opts, async () => {
  // Replying to a notification is a protocol violation some clients treat as
  // fatal, and it is easy to do by accident.
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
    ]);
    assert.equal(responses.length, 1, 'only initialize should produce a response');
  } finally { fx.cleanup(); }
});

test('malformed JSON gets a parse error without killing the session', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const child = spawn(process.execPath, [BIN, 'serve', '--root', fx.root], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });

    child.stdin.write('{ this is not json\n');
    child.stdin.write(JSON.stringify(INIT) + '\n');
    child.stdin.end();

    await new Promise((r) => child.on('close', r));

    const responses = stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(responses[0].error.code, -32700, 'parse error');
    assert.ok(responses[1].result.serverInfo, 'the session survives and keeps serving');
  } finally { fx.cleanup(); }
});

test('an unknown method returns METHOD_NOT_FOUND', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [
      INIT, { jsonrpc: '2.0', id: 2, method: 'no/such/method' },
    ]);
    assert.equal(responses.find((r) => r.id === 2).error.code, -32601);
  } finally { fx.cleanup(); }
});

test('tools/list matches the definitions', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [INIT, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    const names = responses.find((r) => r.id === 2).result.tools.map((t) => t.name);
    assert.deepEqual(names, ['map', 'find']);
  } finally { fx.cleanup(); }
});

test('find returns ranked symbol hits', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'find', arguments: { query: 'findUser' } } },
    ]);
    const text = responses.find((r) => r.id === 2).result.content[0].text;
    assert.match(text, /findUser/);
    assert.match(text, /src\/db\.js/);
  } finally { fx.cleanup(); }
});

test('find on a near-miss suggests the real symbol, never a fabrication', opts, async () => {
  // Why this matters: a bare "nothing found" is a dead end an agent stops at,
  // silently truncating the search (AGENTS.md). The suggestion must come from the
  // real index so the model can self-correct to the name it meant.
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'find', arguments: { query: 'xxlogin' } } },
    ]);
    const text = responses.find((r) => r.id === 2).result.content[0].text;
    assert.match(text, /did you mean/i, 'a no-match must offer guidance, not a bare empty');
    assert.match(text, /handleLogin/, 'the real symbol is surfaced as a suggestion');
  } finally { fx.cleanup(); }
});

test('find with zero similarity says no close matches, and does not invent names', opts, async () => {
  // Never guess silently: an empty-suggestion case must report it honestly.
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'find', arguments: { query: 'qqqqzzzz' } } },
    ]);
    const text = responses.find((r) => r.id === 2).result.content[0].text;
    assert.match(text, /no close matches/i, 'no fabrication when nothing clears the floor');
    assert.match(text, /cgraph update/, 'stale-index hint is still offered');
    assert.ok(!/handleLogin/.test(text), 'must not surface an unrelated symbol as a "suggestion"');
  } finally { fx.cleanup(); }
});

test('find with no index tells the caller to build one', opts, async () => {
  // The empty-index case is distinct from no-match: nothing exists to search yet.
  const fx = await buildFixture({ 'notes/readme.txt': 'no code here\n' });
  try {
    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'find', arguments: { query: 'anything' } } },
    ]);
    const text = responses.find((r) => r.id === 2).result.content[0].text;
    assert.match(text, /cgraph init/i, 'an unbuilt index must point at init/update');
  } finally { fx.cleanup(); }
});

test('map(symbol) on a miss suggests the real symbol too', opts, async () => {
  // The relate-mode miss is the same dead-end trap as find; it must self-correct.
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'map', arguments: { symbol: 'handlLogin', direction: 'callers' } } },
    ]);
    const res = responses.find((r) => r.id === 2);
    assert.equal(res.result.isError, true, 'a miss is still a tool failure');
    assert.match(res.result.content[0].text, /No symbol named/, 'existing lead-in preserved');
    assert.match(res.result.content[0].text, /handleLogin/, 'closest real symbol is suggested');
  } finally { fx.cleanup(); }
});

test('map detail=full adds doc comments; outline default is byte-identical', opts, async () => {
  // #4: the verbosity knob trades context tokens for detail, and the default
  // (no `detail` arg) must reproduce the existing outline exactly.
  const fx = await buildFixture({
    'package.json': '{"name":"t"}',
    'src/a.js': '/** Authenticates a user. */\nexport function handleLogin() { return 1; }\n',
  });
  try {
    const call = async (args) => {
      const { responses } = await session(fx.root, [
        INIT,
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'map', arguments: args } },
      ]);
      return responses.find((r) => r.id === 2).result.content[0].text;
    };
    const defaultOut = await call({ path: 'src/a.js' });
    const outlineOut = await call({ path: 'src/a.js', detail: 'outline' });
    const fullOut = await call({ path: 'src/a.js', detail: 'full' });

    assert.equal(defaultOut, outlineOut, 'omitting `detail` is identical to detail=outline');
    assert.match(outlineOut, /handleLogin/, 'the symbol is present in both modes');
    assert.ok(!/Authenticates a user/.test(outlineOut), 'outline mode carries no doc prose');
    assert.match(fullOut, /Authenticates a user/, 'full mode includes the doc comment');
    assert.ok(fullOut.length > outlineOut.length, 'full mode costs more tokens than outline');
  } finally { fx.cleanup(); }
});

test('map in relate mode reports callers', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'map', arguments: { symbol: 'findUser', direction: 'callers' } } },
    ]);
    assert.match(responses.find((r) => r.id === 2).result.content[0].text, /handleLogin/);
  } finally { fx.cleanup(); }
});

test('map explore combines callers and callees with line ranges', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'map', arguments: { symbol: 'handleLogin', direction: 'explore' } } },
    ]);
    const text = responses.find((r) => r.id === 2).result.content[0].text;
    assert.match(text, /called from \(bottom-up/);
    assert.match(text, /calls \(top-down/);
    assert.match(text, /findUser\s+src[\\/]db\.js:1-1/, 'callee carries an exact start-end range');
  } finally { fx.cleanup(); }
});

test('read, status, and docs are no longer exposed as MCP tools', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: { target: 'findUser' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'docs', arguments: {} } },
    ]);
    assert.match(responses.find((r) => r.id === 2).result.content[0].text, /Unknown tool/);
    assert.match(responses.find((r) => r.id === 3).result.content[0].text, /Unknown tool/);
    assert.match(responses.find((r) => r.id === 4).result.content[0].text, /Unknown tool/);
  } finally { fx.cleanup(); }
});

test('map marks an inferred edge with `!` via the shared formatter', opts, async () => {
  // Why this matters: the INFERRED-edge marker was duplicated as a string
  // literal in the CLI (confMark) and the MCP server (inline ternaries). A
  // confidence-tier change to one site would desync the CLI vs MCP legends and
  // silently break the "verify `!` before relying on it" contract. This asserts
  // the MCP entry point emits the marker from the SAME core helper the CLI uses.
  //
  // `caller` calls `shared` by name with NO import, so the edge is a name-match
  // guess → INFERRED → leading `!`.
  const fx = await buildFixture({
    'package.json': '{"name":"parity"}',
    'src/a.js': 'export function shared() { return 1; }\n',
    'src/b.js': 'export function caller() { return shared(); }\n',
  });
  try {
    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'map', arguments: { symbol: 'shared', direction: 'callers' } } },
    ]);
    const text = responses.find((r) => r.id === 2).result.content[0].text;
    // The marker the helper produces must appear at the start of the caller row.
    const marker = formatConfidence('INFERRED');
    assert.equal(marker, '!', 'helper defines the inferred marker');
    // qname is fully-qualified, so the marker prefixes `src/b.js::caller`.
    assert.ok(text.includes(`${marker} src/b.js::caller`),
      `MCP must mark the inferred caller with the shared marker:\n${text}`);
  } finally { fx.cleanup(); }
});

test('a failing tool returns a readable result, not a protocol error', opts, async () => {
  // A model can act on "no symbol named X, use find" — it cannot act on a
  // JSON-RPC error code.
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'map', arguments: { symbol: 'doesNotExistAnywhere' } } },
    ]);
    const res = responses.find((r) => r.id === 2);
    assert.ok(res.result, 'should be a result, not an error');
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /No symbol named/);
  } finally { fx.cleanup(); }
});

test('an unknown tool name is reported without crashing', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope', arguments: {} } },
    ]);
    assert.match(responses.find((r) => r.id === 2).result.content[0].text, /Unknown tool/);
  } finally { fx.cleanup(); }
});

test('diagnostics go to stderr, never stdout', opts, async () => {
  // Any non-protocol byte on stdout corrupts the stream and disconnects the
  // client with no visible cause.
  const fx = await buildFixture(REPO);
  try {
    const { responses, stderr } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'map', arguments: {} } },
    ]);
    assert.ok(responses.every((r) => r.jsonrpc === '2.0'), 'stdout is pure JSON-RPC');
    assert.match(stderr, /serving/, 'startup diagnostics belong on stderr');
  } finally { fx.cleanup(); }
});

test('map on a bad path suggests the nearest indexed level', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'map', arguments: { path: 'src/nope' } } },
    ]);
    const text = responses.find((r) => r.id === 2).result.content[0].text;
    assert.match(text, /No file or directory/);
    assert.match(text, /Nearest indexed level/, 'a wrong guess should not cost another round trip');
  } finally { fx.cleanup(); }
});

test('map is not truncated by default but honors an explicit budget', opts, async () => {
  // 300 symbols comfortably exceeds the 2000-token default that used to be
  // applied automatically; the outline must come back whole unless the caller
  // asks for a cap.
  const many = Array.from({ length: 300 }, (_, i) => `export function fn${i}() { return ${i}; }`).join('\n');
  const fx = await buildFixture({ 'package.json': '{"name":"t"}', 'src/many.js': many + '\n' });
  try {
    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'map', arguments: { path: 'src/many.js' } } },
    ]);
    const text = responses.find((r) => r.id === 2).result.content[0].text;
    assert.match(text, /fn0\(/);
    assert.match(text, /fn299\(/, 'the whole outline comes back, not just the head');
    assert.ok(!text.includes('raise --budget'), 'no truncation note when no budget was given');

    const { responses: capped } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'map', arguments: { path: 'src/many.js', budget: 50 } } },
    ]);
    const cappedText = capped.find((r) => r.id === 2).result.content[0].text;
    assert.match(cappedText, /raise --budget/, 'an explicit budget still truncates, loudly');
  } finally { fx.cleanup(); }
});

test('an in-flight request still receives a response after stdin closes', async () => {
  const code = `
    import { StdioServer } from ${JSON.stringify(pathToFileURL(PROTOCOL).href)};
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const server = new StdioServer({
      name: 't',
      version: '1',
      handlers: {
        async listTools() { return []; },
        async callTool(name) {
          await delay(50);
          return { content: [{ type: 'text', text: name }] };
        },
      },
    });
    await server.start();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  child.stdin.write(JSON.stringify(INIT) + '\n');
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'delayed', arguments: {} },
  }) + '\n');
  child.stdin.end();

  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
  });

  const responses = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const toolResponse = responses.find((r) => r.id === 2);
  assert.ok(toolResponse, 'expected a tools/call response before process exit');
  assert.equal(toolResponse.result.content[0].text, 'delayed');
});

// ---------------------------------------------------------------- directions
//
// Every branch of toolGraph's direction switch. Each test says which branch it
// covers, because a direction that renders nothing is indistinguishable from a
// direction that was never wired up.

test('map callees lists internal calls (direction=callees, internal rows)', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const res = await toolCall(fx.root, 'map', { symbol: 'handleLogin', direction: 'callees' });
    const text = res.content[0].text;
    assert.match(text, /handleLogin calls:/);
    assert.ok(text.includes(' src/db.js::findUser'), 'EXACT callee renders with a space marker, no !');
    assert.ok(!res.isError);
  } finally { fx.cleanup(); }
});

test('map callees on a leaf says so loudly (direction=callees, empty branch)', opts, async () => {
  const fx = await buildFixture(ONE);
  try {
    const text = (await toolCall(fx.root, 'map', { symbol: 'leaf', direction: 'callees' })).content[0].text;
    assert.match(text, /\(calls nothing this index knows about\)/);
  } finally { fx.cleanup(); }
});

test('map callees separates external packages (direction=callees, external branch)', opts, async () => {
  // Canonical bare-specifier pattern from test/resolve.test.js: express resolves
  // to an externals row, not a file. The agent must see the package/ecosystem.
  const fx = await buildFixture(EXT);
  try {
    const text = (await toolCall(fx.root, 'map', { symbol: 'boot', direction: 'callees' })).content[0].text;
    assert.match(text, /^external:$/m);
    assert.match(text, /express \(npm\)/);
  } finally { fx.cleanup(); }
});

test('map importers lists importing files (direction=importers, rows branch)', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const text = (await toolCall(fx.root, 'map', { symbol: 'findUser', direction: 'importers' })).content[0].text;
    assert.match(text, /files importing src\/db\.js:/);
    assert.match(text, /src\/app\.js:1\s+findUser/);
  } finally { fx.cleanup(); }
});

test('map importers on an unimported file says so (direction=importers, empty branch)', opts, async () => {
  const fx = await buildFixture(ONE);
  try {
    const text = (await toolCall(fx.root, 'map', { symbol: 'leaf', direction: 'importers' })).content[0].text;
    assert.match(text, /\(nothing imports this file\)/);
  } finally { fx.cleanup(); }
});

test('map impact groups direct callers (direction=impact, direct: header)', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const text = (await toolCall(fx.root, 'map', { symbol: 'findUser', direction: 'impact' })).content[0].text;
    assert.match(text, /impact of changing src\/db\.js::findUser: 1 symbols/);
    assert.match(text, /^direct:$/m);
  } finally { fx.cleanup(); }
});

test('map impact truncates a central symbol loudly (direction=impact, truncated branch)', opts, async () => {
  // impact() caps at 200 nodes. A 250-deep chain must report the cap, never a
  // silent short list: the agent needs to know the symbol is central.
  const fx = await buildFixture(CHAIN);
  try {
    const text = (await toolCall(fx.root, 'map', { symbol: 'fn0', direction: 'impact', depth: 300 })).content[0].text;
    assert.match(text, /impact of changing src\/chain\.js::fn0: 200 symbols/);
    assert.match(text, /\(truncated — this symbol is central\)/);
  } finally { fx.cleanup(); }
});

test('map path renders the hop chain (direction=path, found branch)', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const text = (await toolCall(fx.root, 'map', { symbol: 'handleLogin', direction: 'path', to: 'findUser' })).content[0].text;
    assert.match(text, /^1 hops:$/m);
    assert.match(text, /-> src\/db\.js::findUser/);
  } finally { fx.cleanup(); }
});

test('map path on disconnected symbols says no path (direction=path, no-path branch)', opts, async () => {
  const fx = await buildFixture(ISLANDS);
  try {
    const text = (await toolCall(fx.root, 'map', { symbol: 'one', direction: 'path', to: 'two' })).content[0].text;
    assert.match(text, /No call path from src\/one\.js::one to src\/two\.js::two\./);
  } finally { fx.cleanup(); }
});

test('map path without `to` is a readable parameter error (direction=path, missing-to branch)', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const res = await toolCall(fx.root, 'map', { symbol: 'handleLogin', direction: 'path' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /requires a `to` symbol/);
  } finally { fx.cleanup(); }
});

test('map path to a nonexistent symbol names it (direction=path, dest-missing branch)', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const res = await toolCall(fx.root, 'map', { symbol: 'handleLogin', direction: 'path', to: 'ghostSymbol' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /No symbol named 'ghostSymbol'\./);
  } finally { fx.cleanup(); }
});

test('map explore on a leaf reports both empty sides (direction=explore, leaf branches)', opts, async () => {
  const fx = await buildFixture(ONE);
  try {
    const text = (await toolCall(fx.root, 'map', { symbol: 'leaf', direction: 'explore' })).content[0].text;
    assert.match(text, /called from \(bottom-up, 0\):/);
    assert.match(text, /\(no callers — entry point, dead code, or called dynamically\)/);
    assert.match(text, /calls \(top-down, 0\):/);
    assert.match(text, /\(calls nothing this index knows about\)/);
  } finally { fx.cleanup(); }
});

test('map explore surfaces external callees (direction=explore, external branch)', opts, async () => {
  const fx = await buildFixture(EXT);
  try {
    const text = (await toolCall(fx.root, 'map', { symbol: 'boot', direction: 'explore' })).content[0].text;
    assert.match(text, /^ {2}external:$/m);
    assert.match(text, /express \(npm\)/);
  } finally { fx.cleanup(); }
});

test('map explore annotates multi-site callers with (Nx) (explore sites>1 branch)', opts, async () => {
  // explore renders callers with full line ranges; the sites suffix is a
  // separate render path from the callers direction and needs its own test.
  const fx = await buildFixture(TWICE);
  try {
    const text = (await toolCall(fx.root, 'map', { symbol: 'findUser', direction: 'explore' })).content[0].text;
    assert.match(text, /src\/app\.js::handleLogin\s+src\/app\.js:2-2 \(2x\)/);
  } finally { fx.cleanup(); }
});

test('an unknown direction enumerates the valid ones (direction switch, default branch)', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const res = await toolCall(fx.root, 'map', { symbol: 'handleLogin', direction: 'sideways' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Unknown direction 'sideways'\./);
    assert.match(res.content[0].text, /Use callers, callees, importers, impact, path, or explore\./);
  } finally { fx.cleanup(); }
});

test('map callers exact=true keeps EXACT edges (callers minConfidence=EXACT branch)', opts, async () => {
  // handleLogin -> findUser is proven through an import: EXACT. It must survive
  // the exact filter; an inferred-only caller (the shared/caller shape above)
  // must not.
  const fx = await buildFixture(REPO);
  try {
    const text = (await toolCall(fx.root, 'map', { symbol: 'findUser', direction: 'callers', exact: true })).content[0].text;
    assert.ok(text.includes(' src/app.js::handleLogin'), 'EXACT caller survives exact=true');
  } finally { fx.cleanup(); }
});

test('map callers annotates multi-site callers with (Nx) (callers sites>1 branch)', opts, async () => {
  // Two calls from one caller on one line: grouped by caller, sites = 2.
  const fx = await buildFixture(TWICE);
  try {
    const text = (await toolCall(fx.root, 'map', { symbol: 'findUser', direction: 'callers' })).content[0].text;
    assert.match(text, /src\/app\.js::handleLogin\s+src\/app\.js:2 \(2x\)/);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- budget

test('map graph honors an explicit budget, loudly (graph fitToBudget dropped branch)', opts, async () => {
  const fx = await buildFixture(HUB);
  try {
    const text = (await toolCall(fx.root, 'map', { symbol: 'hub', direction: 'callers', budget: 40 })).content[0].text;
    assert.match(text, /\d+ more \(raise budget\)$/, 'the graph truncation note, not the find one');
  } finally { fx.cleanup(); }
});

test('find honors an explicit budget, loudly (find fitToBudget dropped branch)', opts, async () => {
  const many = Array.from({ length: 40 }, (_, i) => `export function fn${i}() { return ${i}; }`).join('\n');
  const fx = await buildFixture({ 'package.json': '{"name":"t"}', 'src/many.js': many + '\n' });
  try {
    const text = (await toolCall(fx.root, 'find', { query: 'fn', budget: 15 })).content[0].text;
    assert.match(text, /\d+ more lines \(raise budget\)$/, 'the find truncation note');
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- find & outline

test('find says when a filter emptied the result (filterNote branch)', opts, async () => {
  // The truncate-loudly contract at the MCP layer: `findUser` exists but
  // kind=class excludes it. The answer must question the filter, not imply
  // absence. (The CLI has this test; the MCP path must not regress without one.)
  const fx = await buildFixture(REPO);
  try {
    const text = (await toolCall(fx.root, 'find', { query: 'findUser', kind: 'class' })).content[0].text;
    assert.match(text, /matched 'findUser'; all excluded by your --kind filter/);
    assert.ok(!/did you mean/i.test(text), 'the filter note replaces the generic suggestion, not appended to it');
  } finally { fx.cleanup(); }
});

test('map on a directory outlines groups (toolMap outlineDir branch)', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    // Prefix 'src': header names the prefix, files sit directly under it.
    const dirText = (await toolCall(fx.root, 'map', { path: 'src' })).content[0].text;
    assert.match(dirText, /^src {2}2 files/m, 'prefix header counts the files under it');
    assert.match(dirText, /src\/app\.js/);

    // No path: root outline — the src group is collapsed, root-level files listed.
    const rootText = (await toolCall(fx.root, 'map', {})).content[0].text;
    assert.match(rootText, /^\. {2}3 files/m, 'root header counts every indexed file');
    assert.match(rootText, /^src\/ {2}2 files/m, 'the src group');
  } finally { fx.cleanup(); }
});

test('map on a slashless bad path offers the root (bad-path parent="" branch)', opts, async () => {
  // src/nope (covered above) takes the parent='src' path; 'nope' takes the
  // parent='' path, which renders Nearest indexed level (.).
  const fx = await buildFixture(REPO);
  try {
    const text = (await toolCall(fx.root, 'map', { path: 'nope' })).content[0].text;
    assert.match(text, /No file or directory 'nope'\./);
    assert.match(text, /Nearest indexed level \(\.\):/);
  } finally { fx.cleanup(); }
});

test('map with a kind filter that matches nothing says so (outlineFile no-symbols branch)', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const text = (await toolCall(fx.root, 'map', { path: 'src/db.js', kinds: ['class'] })).content[0].text;
    assert.match(text, /\(no symbols extracted\)/);
  } finally { fx.cleanup(); }
});

// ---------------------------------------------------------------- server failure paths

test('similar without embeddings is a readable refusal, not a crash (toolSimilar OFF branch)', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const res = await toolCall(fx.root, 'similar', { query: 'anything' });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Semantic search is not configured/);
    assert.match(res.content[0].text, /cgraph index --embed/);
  } finally { fx.cleanup(); }
});

test('a throwing handler becomes a readable tool result (callTool catch branch)', opts, async () => {
  // kinds:5 is a schema violation the server does not pre-validate; outlineFile
  // throws (kinds.includes is not a function) and callTool must convert it to
  // `${name} failed: ...` rather than a protocol error.
  const fx = await buildFixture(REPO);
  try {
    const res = await toolCall(fx.root, 'map', { path: 'src/db.js', kinds: 5 });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /^map failed: /);
  } finally { fx.cleanup(); }
});

test('a stale index is disclosed in the answer (staleness >=10min branch)', opts, async () => {
  // autoRefresh normally rewrites last_indexed_at on the first call, which is
  // why this branch reads as unreachable. Disabling autoRefresh via the real
  // config file and backdating the meta row reaches it exactly as an offline
  // (watch-less) deployment hits it. The config file also drives the
  // Refresher.maybe() enabled===false early return.
  const fx = await buildFixture(REPO);
  try {
    fs.writeFileSync(
      path.join(fx.root, '.cgraph', 'config.json'),
      JSON.stringify({ autoRefresh: { enabled: false } })
    );
    fx.store.setMeta('last_indexed_at', String(Date.now() - 20 * 60000));
    // Release the fixture's own handle on the db so the server child can open
    // it; the tree itself must survive for the session.
    fx.store.close();
    fx.registry.dispose();

    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'map', arguments: { symbol: 'findUser' } } },
    ]);
    const text = responses.find((r) => r.id === 2).result.content[0].text;
    assert.match(text, /\(index last updated 20 min ago — run `cgraph update` to refresh\)/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- framing & protocol

test('blank lines never reach the dispatcher (start() blank-line skip)', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const init = JSON.stringify(INIT);
    const { responses } = await rawSession(fx.root, ['\n', '   \n', init + '\n', '\n']);
    assert.equal(responses.length, 1, 'blank frames produce no replies and no parse errors');
    assert.ok(responses[0].result.serverInfo);
  } finally { fx.cleanup(); }
});

test('a frame split across chunks reassembles (readline chunk-boundary framing)', opts, async () => {
  // The failure mode this guards: a client whose TCP writes straddle a JSON
  // boundary. If the server parsed per-chunk instead of per-line, the second
  // half would be a parse error and the response would be lost.
  const fx = await buildFixture(REPO);
  try {
    const init = JSON.stringify(INIT) + '\n';
    const half = Math.floor(init.length / 2);
    const { responses } = await rawSession(fx.root, [init.slice(0, half), init.slice(half)]);
    assert.equal(responses.length, 1);
    assert.ok(responses[0].result.serverInfo);
  } finally { fx.cleanup(); }
});

test('two frames in one write both get responses (batched frames)', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const ping = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' });
    const { responses } = await rawSession(fx.root, [JSON.stringify(INIT) + '\n' + ping + '\n']);
    assert.deepEqual(responses.map((r) => r.id).sort((a, b) => a - b), [1, 2]);
  } finally { fx.cleanup(); }
});

test('ping answers with an empty result (dispatch ping branch)', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [INIT, { jsonrpc: '2.0', id: 2, method: 'ping' }]);
    assert.deepEqual(responses.find((r) => r.id === 2).result, {});
  } finally { fx.cleanup(); }
});

test('a request without jsonrpc 2.0 is INVALID_REQUEST, id preserved (jsonrpc guard, id branch)', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [{ id: 9, method: 'ping' }]);
    assert.equal(responses[0].error.code, -32600);
    assert.equal(responses[0].id, 9, 'the caller must be able to correlate the rejection');
  } finally { fx.cleanup(); }
});

test('a jsonrpc-less request without id is rejected with id null (jsonrpc guard, id ?? null)', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [{ method: 'ping' }]);
    assert.equal(responses[0].error.code, -32600);
    assert.equal(responses[0].id, null);
  } finally { fx.cleanup(); }
});

test('tools/call without a name is INVALID_PARAMS (dispatch tools/call missing-name branch)', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [INIT, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} }]);
    assert.equal(responses.find((r) => r.id === 2).error.code, -32602);
  } finally { fx.cleanup(); }
});

test('resources/list and prompts/list answer empty, not METHOD_NOT_FOUND (capability probe branch)', opts, async () => {
  // Clients that probe capabilities treat -32601 as "server is broken"; an
  // honest empty list is the documented answer.
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'resources/list' },
      { jsonrpc: '2.0', id: 3, method: 'prompts/list' },
    ]);
    assert.deepEqual(responses.find((r) => r.id === 2).result, { resources: [] });
    assert.deepEqual(responses.find((r) => r.id === 3).result, { prompts: [] });
  } finally { fx.cleanup(); }
});

test('initialized (the bare alias) is accepted as a notification (initialized alias branch)', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [INIT, { jsonrpc: '2.0', method: 'initialized' }]);
    assert.equal(responses.length, 1, 'the alias, like notifications/initialized, never replies');
  } finally { fx.cleanup(); }
});

test('a failing notification is logged to stderr with no reply (notification throw -> _logError)', opts, async () => {
  // tools/call without a name throws inside the dispatcher; with no id there is
  // no reply to send, so the ONLY observable behavior is the stderr log.
  const fx = await buildFixture(REPO);
  try {
    const { responses, stderr } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', method: 'tools/call', params: {} },
    ]);
    assert.equal(responses.length, 1, 'a notification must not receive a response, even on failure');
    assert.match(stderr, /requires a name/, 'the failure reason is on stderr, where stdout stays pure');
  } finally { fx.cleanup(); }
});

test('a handler throw with no code becomes INTERNAL -32603 (err.code ?? INTERNAL branch)', async () => {
  // The real server never throws codeless from callTool (callTool catches
  // everything), so this branch is only reachable through a handler that does.
  // Direct StdioServer instance, same in-process harness as the in-flight test.
  const code = `
    import { StdioServer } from ${JSON.stringify(pathToFileURL(PROTOCOL).href)};
    const server = new StdioServer({
      name: 't',
      version: '1',
      handlers: {
        async listTools() { return []; },
        async callTool() { throw new Error('boom from handler'); },
      },
    });
    await server.start();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });

  child.stdin.write(JSON.stringify(INIT) + '\n');
  child.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x', arguments: {} },
  }) + '\n');
  child.stdin.end();
  await new Promise((r) => child.on('close', r));

  const responses = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const toolResponse = responses.find((r) => r.id === 2);
  assert.equal(toolResponse.error.code, -32603, 'a codeless throw maps to INTERNAL');
  assert.match(toolResponse.error.message, /boom from handler/);
});

test('an oversized frame fails as a readable tool result, not a crash (server survives a 45K-char query)', opts, async () => {
  // A 45,000-char query turns trigramMatches into ~45k SQL placeholders, past
  // SQLite's variable limit: store.all throws, callTool's catch converts it. The
  // session must stay alive and stdout pure. This is the degrade-don't-crash
  // contract under the worst input a frame can carry.
  const fx = await buildFixture(REPO);
  try {
    const big = Array.from({ length: 9000 }, (_, i) => `q${i}z`).join('');
    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'find', arguments: { query: big } } },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
    ]);
    const res = responses.find((r) => r.id === 2).result;
    assert.equal(res.isError, true, 'the oversized query becomes a tool result, not a protocol error');
    assert.match(res.content[0].text, /^find failed: /);
    assert.deepEqual(responses.find((r) => r.id === 3).result, {}, 'the session keeps serving after the monster frame');
  } finally { fx.cleanup(); }
});
