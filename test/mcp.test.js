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
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildFixture } from './fixture.js';
import { toolDefinitions } from '../src/mcp/tools.js';
import { estimate } from '../src/core/tokens.js';

const require = createRequire(import.meta.url);
const skip = (() => {
  try { require.resolve('tree-sitter-wasms/package.json'); return false; }
  catch { return true; }
})();
const opts = { skip };

const BIN = fileURLToPath(new URL('../bin/cgraph.js', import.meta.url));

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

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};

const REPO = {
  'package.json': '{"name":"t"}',
  'src/db.js': 'export function findUser(id) { return id; }\n',
  'src/app.js': "import { findUser } from './db';\nexport function handleLogin(email) { return findUser(email); }\n",
};

test('tool schemas stay within their token budget', () => {
  // Guards against description creep. Every token here is paid on every turn of
  // every conversation, forever.
  const tokens = estimate(JSON.stringify(toolDefinitions({})));
  assert.ok(tokens < 1400, `tool schemas cost ${tokens} tokens; budget is 1400`);
});

test('exposes exactly the intended tool set', () => {
  const names = toolDefinitions({}).map((t) => t.name);
  assert.deepEqual(names, ['map', 'find', 'read', 'graph', 'docs', 'status']);
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
    assert.deepEqual(names, ['map', 'find', 'read', 'graph', 'docs', 'status']);
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

test('graph reports callers', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'graph', arguments: { symbol: 'findUser', direction: 'callers' } } },
    ]);
    assert.match(responses.find((r) => r.id === 2).result.content[0].text, /handleLogin/);
  } finally { fx.cleanup(); }
});

test('read returns one symbol body', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: { target: 'findUser' } } },
    ]);
    const text = responses.find((r) => r.id === 2).result.content[0].text;
    assert.match(text, /export function findUser/);
    assert.ok(!text.includes('handleLogin'), 'should not leak the other file');
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
        params: { name: 'read', arguments: { target: 'doesNotExistAnywhere' } } },
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

test('status reports index statistics', opts, async () => {
  const fx = await buildFixture(REPO);
  try {
    const { responses } = await session(fx.root, [
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'status', arguments: { refresh: false } } },
    ]);
    const text = responses.find((r) => r.id === 2).result.content[0].text;
    assert.match(text, /symbols/);
    assert.match(text, /edges/);
  } finally { fx.cleanup(); }
});
