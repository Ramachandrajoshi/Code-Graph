/**
 * Schema guards.
 *
 * These test the migration list as data rather than testing SQLite. Both rules
 * below have already broken this codebase once each, and both fail in ways that
 * point nowhere near the actual mistake.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MIGRATIONS, SCHEMA_VERSION } from '../src/core/schema.js';

test('migration SQL contains no backticks', () => {
  // A backtick inside the template literal terminates it, and the resulting
  // SyntaxError names an arbitrary identifier from the SQL with no line number
  // that means anything. Cheap to test, expensive to debug.
  for (const m of MIGRATIONS) {
    assert.ok(
      !m.up.includes('`'),
      `Migration ${m.version} (${m.name}) contains a backtick inside a template literal`
    );
  }
});

test('migration versions are sequential from 1 with no gaps or duplicates', () => {
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(
    versions,
    versions.map((_, i) => i + 1),
    'migrations must be a dense, ordered sequence starting at 1'
  );
});

test('SCHEMA_VERSION matches the highest migration', () => {
  assert.equal(SCHEMA_VERSION, MIGRATIONS.at(-1).version);
});

test('every migration has a name', () => {
  for (const m of MIGRATIONS) {
    assert.ok(m.name && typeof m.name === 'string', `migration ${m.version} needs a name`);
  }
});

test('the source file has no stray backticks in the SQL region', () => {
  // Belt and braces: catches a backtick added to a *new* migration by someone
  // who has not read the note at the top of schema.js.
  const src = readFileSync(fileURLToPath(new URL('../src/core/schema.js', import.meta.url)), 'utf8');
  const sqlRegions = [...src.matchAll(/up:\s*`([\s\S]*?)`,\n/g)];
  assert.ok(sqlRegions.length >= 1, 'expected at least one migration SQL block');
  for (const [, sql] of sqlRegions) {
    assert.ok(!sql.includes('`'), 'SQL region contains a backtick');
  }
});
