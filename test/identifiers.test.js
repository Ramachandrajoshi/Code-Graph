import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitIdentifier, identifierParts, trigrams } from '../src/core/identifiers.js';

test('splits camelCase', () => {
  assert.deepEqual(splitIdentifier('handleLogin'), ['handle', 'login']);
  assert.deepEqual(splitIdentifier('getUserById'), ['get', 'user', 'by', 'id']);
});

test('splits PascalCase', () => {
  assert.deepEqual(splitIdentifier('LoginService'), ['login', 'service']);
});

test('splits snake_case and SCREAMING_SNAKE', () => {
  assert.deepEqual(splitIdentifier('login_user'), ['login', 'user']);
  assert.deepEqual(splitIdentifier('LOGIN_TIMEOUT'), ['login', 'timeout']);
});

test('splits kebab-case and dotted names', () => {
  assert.deepEqual(splitIdentifier('login-user'), ['login', 'user']);
  assert.deepEqual(splitIdentifier('os.path.join'), ['os', 'path', 'join']);
});

test('breaks acronym runs at the right place', () => {
  // The boundary belongs before the last capital, so the acronym stays intact.
  assert.deepEqual(splitIdentifier('HTTPLoginClient'), ['http', 'login', 'client']);
  assert.deepEqual(splitIdentifier('parseXMLDocument'), ['parse', 'xml', 'document']);
  assert.deepEqual(splitIdentifier('URL'), ['url']);
});

test('separates digit boundaries', () => {
  assert.deepEqual(splitIdentifier('parseURL2Path'), ['parse', 'url', '2', 'path']);
  assert.deepEqual(splitIdentifier('sha256Hash'), ['sha', '256', 'hash']);
});

test('handles leading underscores and dunder names', () => {
  assert.deepEqual(splitIdentifier('_private'), ['private']);
  assert.deepEqual(splitIdentifier('__init__'), ['init']);
});

test('identifierParts is empty for single-word names', () => {
  // Nothing to gain from duplicating a name that does not decompose.
  assert.equal(identifierParts('login'), '');
  assert.equal(identifierParts('handleLogin'), 'handle login');
});

test('handles empty and degenerate input', () => {
  assert.deepEqual(splitIdentifier(''), []);
  assert.deepEqual(splitIdentifier('___'), []);
  assert.equal(identifierParts(''), '');
});

test('trigrams cover every 3-character window', () => {
  assert.deepEqual(trigrams('login').sort(), ['gin', 'log', 'ogi'].sort());
});

test('trigrams handle short names without crashing', () => {
  assert.deepEqual(trigrams('ab'), ['ab']);
  assert.deepEqual(trigrams(''), []);
});

test('trigrams are deduplicated', () => {
  const t = trigrams('aaaa');
  assert.deepEqual(t, ['aaa'], 'repeated windows collapse to one row');
});
