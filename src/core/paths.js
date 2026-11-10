/**
 * Path normalization boundary.
 *
 * Rule for the whole codebase: every path that crosses into the index — into the
 * database, into a query, into rendered output — is POSIX-style and relative to
 * the repo root. Native separators exist only when touching the filesystem.
 *
 * This module is the single place that converts between the two. Doing it
 * anywhere else is how you end up with `src/auth\login.ts` in a graph DB.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

/** Convert a native path to POSIX form (`a\b` -> `a/b`). Idempotent on POSIX. */
export function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** Convert a POSIX-style path to the platform's native form. */
export function toNative(p) {
  return p.split('/').join(path.sep);
}

/**
 * Repo-relative POSIX path for `abs`, which must live under `root`.
 * Returns null when `abs` escapes the root — callers treat that as "skip".
 */
export function relFromRoot(root, abs) {
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return toPosix(rel);
}

/**
 * Absolute native path for a repo-relative POSIX path.
 *
 * Throws when the result would land outside `root`. The paths passed here come
 * out of the index, and the index is a file in the project directory — one a
 * repository can ship pre-built. A row whose path is `../../.ssh/id_rsa` must
 * not turn "read this symbol" into "print that file".
 */
export function absFromRoot(root, rel) {
  const abs = path.resolve(root, toNative(rel));
  const back = path.relative(path.resolve(root), abs);
  if (back.startsWith('..') || path.isAbsolute(back)) {
    throw Object.assign(new Error(`path escapes the project root: ${rel}`), { code: 'EOUTSIDE' });
  }
  return abs;
}

/**
 * Walk upward from `start` looking for a directory marker (`.git`, `.cgraph`).
 * Returns the containing directory, or null.
 *
 * @param {(markerPath: string) => boolean} [accept] a marker that exists is
 *   only counted when this returns true; the walk carries on upward otherwise.
 */
export function findUp(start, markers, accept = null) {
  let dir = path.resolve(start);
  for (;;) {
    for (const marker of markers) {
      const candidate = path.join(dir, marker);
      if (fs.existsSync(candidate) && (!accept || accept(candidate))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Locate the project root for a given working directory.
 *
 * Prefers an existing `.cgraph/` (the user has already chosen a root here),
 * then `.git/`, then falls back to cwd so the tool still works in a directory
 * that isn't a repo at all.
 */
export function findProjectRoot(cwd = process.cwd()) {
  return (
    findUp(cwd, ['.cgraph'], isProjectIndexDir) ??
    findUp(cwd, ['.git']) ??
    path.resolve(cwd)
  );
}

/**
 * Is this `.cgraph` a project's index directory, rather than the machine-wide
 * cache?
 *
 * The cache — grammars, user packs, the trust list — lives in `~/.cgraph`,
 * the same name a project's index directory has. Taken as a project marker,
 * it made the home directory the "project root" of every directory beneath it
 * that had not been initialised yet: `cgraph index` in a fresh clone would
 * set about indexing the whole home directory, and the tests for this function
 * failed on any machine that had ever used the tool.
 *
 * The cache directory still counts when it holds an index, which is what a
 * person who really did run `cgraph init` in their home directory has.
 */
function isProjectIndexDir(dir) {
  // Both the configured cache and the default location: with CGRAPH_HOME set,
  // a `~/.cgraph` left over from before it was set is still not a project.
  const resolved = path.resolve(dir);
  const caches = [path.join(os.homedir(), '.cgraph')];
  if (process.env.CGRAPH_HOME) caches.push(path.resolve(process.env.CGRAPH_HOME));
  if (!caches.includes(resolved)) return true;
  return fs.existsSync(path.join(dir, 'index.db'));
}

/** Split a repo-relative path into its directory segments (no filename). */
export function dirSegments(rel) {
  const parts = rel.split('/');
  parts.pop();
  return parts;
}

/** Lowercase extension including the dot, or '' when there is none. */
export function extname(rel) {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  // A leading dot means a dotfile (`.gitignore`), not an extension.
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

/** Final path segment. */
export function basename(rel) {
  return rel.slice(rel.lastIndexOf('/') + 1);
}
