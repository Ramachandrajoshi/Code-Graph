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

/** Absolute native path for a repo-relative POSIX path. */
export function absFromRoot(root, rel) {
  return path.join(root, toNative(rel));
}

/**
 * Walk upward from `start` looking for a directory marker (`.git`, `.cgraph`).
 * Returns the containing directory, or null.
 */
export function findUp(start, markers) {
  let dir = path.resolve(start);
  for (;;) {
    for (const marker of markers) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
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
    findUp(cwd, ['.cgraph']) ??
    findUp(cwd, ['.git']) ??
    path.resolve(cwd)
  );
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
