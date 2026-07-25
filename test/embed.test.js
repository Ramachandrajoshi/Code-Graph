/**
 * Embedding and LSP tests.
 *
 * Neither subsystem is exercised against a live service — that would make the
 * suite slow, flaky, and dependent on an API key. What IS tested is everything
 * that can be wrong without a network: vector encoding, similarity maths,
 * configuration handling, and the LSP wire framing (which is a different
 * protocol from MCP and easy to conflate).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Embedder, packVector, unpackVector, cosine, symbolText } from '../src/embed/index.js';
import { LspClient } from '../src/lsp/client.js';

// ---------------------------------------------------------------- vectors

test('vectors survive a pack/unpack round trip', () => {
  const original = [0.5, -0.25, 0, 1, -1];
  const restored = unpackVector(packVector(original));
  assert.equal(restored.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assert.ok(Math.abs(restored[i] - original[i]) < 1e-6, `element ${i} drifted`);
  }
});

test('packed vectors use 4 bytes per float', () => {
  assert.equal(packVector([1, 2, 3]).length, 12);
});

test('cosine similarity is 1 for identical vectors', () => {
  const v = [0.1, 0.2, 0.3];
  assert.ok(Math.abs(cosine(Float32Array.from(v), Float32Array.from(v)) - 1) < 1e-6);
});

test('cosine similarity is 0 for orthogonal vectors', () => {
  assert.ok(Math.abs(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))) < 1e-6);
});

test('cosine similarity is -1 for opposite vectors', () => {
  assert.ok(Math.abs(cosine(Float32Array.from([1, 0]), Float32Array.from([-1, 0])) + 1) < 1e-6);
});

test('cosine handles a zero vector without dividing by zero', () => {
  // A provider returning zeros would otherwise yield NaN and silently corrupt
  // the entire ranking rather than failing visibly.
  assert.equal(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1])), 0);
});

test('cosine normalizes, so magnitude does not affect ranking', () => {
  const a = Float32Array.from([1, 1]);
  const scaled = Float32Array.from([10, 10]);
  const other = Float32Array.from([1, 0]);
  assert.ok(Math.abs(cosine(a, other) - cosine(scaled, other)) < 1e-6);
});

// ---------------------------------------------------------------- embedded text

test('symbolText embeds the declaration and docs, not the body', () => {
  // Bodies are mostly syntax; they embed poorly and pull every function toward
  // the same region of the vector space.
  const text = symbolText({
    kind: 'function', qname: 'src/a.ts::login',
    signature: 'login(email: string): Promise<Session>',
    doc: 'Authenticates a user.',
  });
  assert.match(text, /login\(email: string\)/);
  assert.match(text, /Authenticates a user/);
  assert.match(text, /function/);
});

test('symbolText tolerates missing signature and doc', () => {
  const text = symbolText({ kind: 'class', qname: 'a::B', name: 'B' });
  assert.match(text, /B/);
  assert.ok(!text.includes('undefined'), 'missing fields must not leak into the vector');
});

test('symbolText is length-capped', () => {
  const text = symbolText({ kind: 'function', qname: 'q', signature: 'x'.repeat(5000), doc: 'y'.repeat(5000) });
  assert.ok(text.length <= 1000);
});

// ---------------------------------------------------------------- configuration

test('fromConfig returns null when embeddings are disabled', () => {
  // Returning null rather than throwing keeps every call site free of
  // "is this enabled" branching.
  assert.equal(Embedder.fromConfig({ embeddings: { enabled: false } }), null);
  assert.equal(Embedder.fromConfig({}), null);
});

test('fromConfig demands a provider when enabled', () => {
  assert.throws(
    () => Embedder.fromConfig({ embeddings: { enabled: true } }),
    /provider is not set/
  );
});

test('fromConfig reports a missing API key by env var name', () => {
  assert.throws(
    () => Embedder.fromConfig({
      embeddings: { enabled: true, provider: 'voyage', apiKeyEnv: 'DEFINITELY_NOT_SET_KEY' },
    }),
    /DEFINITELY_NOT_SET_KEY is not set/
  );
});

test('an unknown provider is rejected with the known list', () => {
  assert.throws(
    () => new Embedder({ provider: 'nope', apiKey: 'x' }),
    /Known: voyage, openai/
  );
});

test('the API key is never stored in config, only its env var name', () => {
  process.env.CGRAPH_TEST_KEY = 'secret-value';
  try {
    const embedder = Embedder.fromConfig({
      embeddings: { enabled: true, provider: 'openai', apiKeyEnv: 'CGRAPH_TEST_KEY' },
    });
    assert.equal(embedder.apiKey, 'secret-value');
    assert.equal(embedder.model, 'text-embedding-3-small', 'a sensible default model');
  } finally {
    delete process.env.CGRAPH_TEST_KEY;
  }
});

// ---------------------------------------------------------------- LSP framing

test('LSP messages use Content-Length framing, not newline delimiting', () => {
  // MCP is newline-delimited JSON; LSP is header-framed. Conflating the two
  // produces a client that connects and then silently never communicates.
  const written = [];
  const client = new LspClient({ command: 'noop', root: process.cwd() });
  client.child = { stdin: { write: (chunk) => written.push(chunk) } };

  client._notify('initialized', {});

  const header = written[0].toString();
  assert.match(header, /^Content-Length: \d+\r\n\r\n$/);

  const body = JSON.parse(written[1].toString());
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.method, 'initialized');
  assert.equal(body.id, undefined, 'a notification carries no id');
});

test('Content-Length counts bytes, not characters', () => {
  // A multi-byte character makes byte length and string length differ; using
  // the wrong one truncates the message and desynchronises the stream forever.
  const written = [];
  const client = new LspClient({ command: 'noop', root: process.cwd() });
  client.child = { stdin: { write: (chunk) => written.push(chunk) } };

  client._notify('test', { text: 'héllo wörld — ünicode' });

  const declared = Number(written[0].toString().match(/Content-Length: (\d+)/)[1]);
  assert.equal(declared, Buffer.byteLength(written[1]), 'declared length must equal actual bytes');
  assert.ok(declared > JSON.stringify({ jsonrpc: '2.0', method: 'test' }).length);
});

test('LSP responses are parsed out of a chunked stream', () => {
  // TCP and pipes split messages arbitrarily; a parser that assumes one message
  // per chunk works in testing and fails under load.
  const client = new LspClient({ command: 'noop', root: process.cwd() });

  let resolved = null;
  client.pending.set(7, { resolve: (v) => { resolved = v; }, reject: () => {}, timer: setTimeout(() => {}, 0) });

  const body = JSON.stringify({ jsonrpc: '2.0', id: 7, result: { ok: true } });
  const full = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);

  client._onData(full.subarray(0, 10));
  assert.equal(resolved, null, 'nothing resolves from a partial header');
  client._onData(full.subarray(10, 30));
  client._onData(full.subarray(30));

  assert.deepEqual(resolved, { ok: true }, 'the message resolves once fully received');
});

test('two LSP messages in one chunk are both parsed', () => {
  const client = new LspClient({ command: 'noop', root: process.cwd() });
  const got = [];
  for (const id of [1, 2]) {
    client.pending.set(id, { resolve: (v) => got.push(v), reject: () => {}, timer: setTimeout(() => {}, 0) });
  }

  const frame = (obj) => {
    const b = JSON.stringify(obj);
    return `Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`;
  };
  client._onData(Buffer.from(
    frame({ jsonrpc: '2.0', id: 1, result: 'a' }) + frame({ jsonrpc: '2.0', id: 2, result: 'b' })
  ));

  assert.deepEqual(got, ['a', 'b']);
});

test('an LSP error response rejects rather than resolving', () => {
  const client = new LspClient({ command: 'noop', root: process.cwd() });
  let rejected = null;
  client.pending.set(3, {
    resolve: () => {}, reject: (e) => { rejected = e; }, timer: setTimeout(() => {}, 0),
  });

  const body = JSON.stringify({ jsonrpc: '2.0', id: 3, error: { code: -1, message: 'boom' } });
  client._onData(Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));

  assert.match(rejected.message, /boom/);
});

test('starting a missing language server fails cleanly', async () => {
  // A missing server must degrade to the tree-sitter answer, not crash a query.
  const client = new LspClient({
    command: 'definitely-not-a-real-language-server-xyz', root: process.cwd(),
  });
  await assert.rejects(() => client.start());
  client.stop();
});
