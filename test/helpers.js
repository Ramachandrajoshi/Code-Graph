/**
 * Test helpers: build throwaway repos on disk and tear them down.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULTS } from '../src/core/config.js';

/**
 * Create a temp directory tree from a flat `{ 'a/b.js': 'content' }` map.
 * Returns the root path plus a cleanup function.
 */
export function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel.split('/').join(path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return {
    root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Config for tests. The default ignore list is intentionally opinionated
 * (it drops vendor/, build/, minified files) which would mask walker bugs, so
 * tests opt out unless they are specifically exercising it.
 */
export function testConfig(root, overrides = {}) {
  return { ...DEFAULTS, ignore: [], root, ...overrides };
}

export function withRepo(files, fn) {
  const { root, cleanup } = makeRepo(files);
  try {
    return fn(root);
  } finally {
    cleanup();
  }
}
