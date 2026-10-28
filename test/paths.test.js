/**
 * Path-boundary unit tests.
 *
 * paths.js is the only place native <-> POSIX conversion happens. A bug here
 * silently writes `src\auth\login.ts` into the graph DB and every consumer
 * downstream inherits it. These are pure-function tests: no pipeline, no
 * grammars, just the exact conversion contract. The escaping-above-root branch
 * is platform-dependent, so the assertions branch on path.sep.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  toPosix, toNative, relFromRoot, absFromRoot,
  findUp, findProjectRoot, dirSegments, extname, basename,
} from '../src/core/paths.js';

const isWin = path.sep === '\\';

test('toPosix replaces native separators and is idempotent', () => {
  // The conversion the whole codebase relies on: a native path entering the
  // index becomes POSIX. On POSIX it's a no-op, so the split/join is a no-op.
  assert.equal(toPosix('a/b/c'), 'a/b/c');
  assert.equal(toPosix('a' + path.sep + 'b' + path.sep + 'c'), 'a/b/c');
  assert.equal(toPosix('a/b/c'), toPosix(toPosix('a/b/c')), 'idempotent');
});

test('toNative produces platform separators', () => {
  assert.equal(toNative('a/b/c'), ['a', 'b', 'c'].join(path.sep));
  // Idempotent: splitting a POSIX string and rejoining with the same sep.
  assert.equal(toNative('a'), 'a');
});

test('relFromRoot returns a POSIX repo-relative path', () => {
  const root = path.resolve(isWin ? 'C:\\repo' : '/repo');
  assert.equal(relFromRoot(root, path.join(root, 'src', 'a.js')), 'src/a.js');
  // Nested deeper, all separators normalized.
  assert.equal(
    relFromRoot(root, path.join(root, 'src', 'auth', 'login.ts')),
    'src/auth/login.ts'
  );
});

test('relFromRoot returns null when abs escapes the root', () => {
  const root = path.resolve(isWin ? 'C:\\repo\\inner' : '/repo/inner');
  // A sibling outside root -> path.relative yields leading '..'.
  assert.equal(relFromRoot(root, path.resolve(isWin ? 'C:\\repo\\other\\a.js' : '/repo/other/a.js')), null);
  // The root itself (empty relative) is also treated as "skip".
  assert.equal(relFromRoot(root, root), null);
  // Absolute-when-relative is the `path.isAbsolute(rel)` guard. On POSIX a
  // leading-slash target yields an absolute rel; Windows has no such case, so
  // the branch is covered by the escape case above on this platform.
  if (!isWin) {
    assert.equal(relFromRoot('/repo/a', '/etc/passwd'), null);
  }
});

test('absFromRoot joins a POSIX repo path onto the root as native', () => {
  const root = path.resolve(isWin ? 'C:\\repo' : '/repo');
  assert.equal(absFromRoot(root, 'src/a.js'), path.join(root, ['src', 'a.js'].join(path.sep)));
});

test('findUp returns the nearest ancestor directory containing a marker', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-paths-'));
  try {
    const deep = path.join(base, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    // Marker lives two levels up from the start.
    fs.writeFileSync(path.join(base, 'a', '.git'), 'gitfile');

    assert.equal(findUp(deep, ['.git']), path.resolve(base, 'a'));
    assert.equal(findUp(deep, ['.cgraph']), null, 'no .cgraph anywhere in this tree');

    // Multiple markers: the first directory that holds ANY of them wins.
    fs.writeFileSync(path.join(base, 'a', 'b', '.cgraph'), 'x');
    assert.equal(findUp(deep, ['.git', '.cgraph']), path.resolve(base, 'a', 'b'),
      'walks up and matches the deepest directory holding any marker');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('findUp reaches the filesystem root and returns null', () => {
  // The loop terminates at the drive/volume root; a marker that exists nowhere
  // above a deep temp path must yield null, not throw or loop forever.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-paths-'));
  try {
    fs.mkdirSync(path.join(base, 'x'), { recursive: true });
    assert.equal(findUp(path.join(base, 'x'), ['__definitely_not_present_marker__']), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('findProjectRoot prefers .cgraph, then .git, then falls back to cwd', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cgraph-paths-'));
  try {
    // Case 1: .cgraph wins over a deeper .git — the user already chose this root.
    const cgraphRoot = path.join(base, 'proj-c');
    fs.mkdirSync(path.join(cgraphRoot, '.cgraph'), { recursive: true });
    fs.mkdirSync(path.join(cgraphRoot, 'src', '.git'), { recursive: true });
    assert.equal(
      findProjectRoot(path.join(cgraphRoot, 'src')),
      path.resolve(cgraphRoot),
      '.cgraph closest-root preference'
    );

    // Case 2: only .git present, at the project root; start from a plain subdir.
    const gitRoot = path.join(base, 'proj-git');
    fs.mkdirSync(path.join(gitRoot, '.git'), { recursive: true });
    fs.mkdirSync(path.join(gitRoot, 'src'), { recursive: true });
    assert.equal(
      findProjectRoot(path.join(gitRoot, 'src')),
      path.resolve(gitRoot),
      'falls back to .git'
    );

    // Case 3: no markers — must fall back to the resolved cwd, not throw.
    const plain = path.join(base, 'plain');
    fs.mkdirSync(plain, { recursive: true });
    // Guard: only assert if no .git/.cgraph exists in ancestors of tempdir.
    if (findUp(plain, ['.cgraph', '.git']) === null) {
      assert.equal(findProjectRoot(plain), path.resolve(plain), 'cwd fallback when no repo markers exist');
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('dirSegments returns directory parts without the filename', () => {
  assert.deepEqual(dirSegments('src/auth/login.ts'), ['src', 'auth']);
  assert.deepEqual(dirSegments('README.md'), [], 'a root file has no directory segments');
  assert.deepEqual(dirSegments('a/b/c/d.txt'), ['a', 'b', 'c']);
});

test('extname lowercases the extension and distinguishes dotfiles', () => {
  assert.equal(extname('src/a.TS'), '.ts', 'lowercased');
  assert.equal(extname('src/a'), '', 'no extension');
  // A leading dot is a dotfile, not an extension — the dot<=0 guard.
  assert.equal(extname('.gitignore'), '');
  assert.equal(extname('dir/.hidden'), '', 'dotfile in a directory');
  assert.equal(extname('archive.tar.gz'), '.gz', 'last dot wins');
});

test('basename returns the final segment', () => {
  assert.equal(basename('src/auth/login.ts'), 'login.ts');
  assert.equal(basename('README.md'), 'README.md', 'no directory: whole string');
  assert.equal(basename('.hidden'), '.hidden');
});
