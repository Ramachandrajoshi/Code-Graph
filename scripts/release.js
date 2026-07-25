#!/usr/bin/env node
/**
 * Cut a release: bump the version, update the changelog, tag, and push.
 *
 * The tag is what triggers publishing, so this script exists to make it
 * impossible to create one that disagrees with package.json — the single most
 * common release mistake, and one that produces an immutable wrong version on a
 * registry that does not allow deletion.
 *
 * Everything is checked BEFORE anything is written. A release that is going to
 * fail should fail while the working tree is still untouched.
 *
 *   npm run release -- patch
 *   npm run release -- minor
 *   npm run release -- 1.2.3
 *   npm run release -- prerelease --preid beta
 *   npm run release -- patch --dry-run
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/Ramachandrajoshi/Code-Graph';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const preidIndex = argv.indexOf('--preid');
const preid = preidIndex !== -1 ? argv[preidIndex + 1] : 'beta';
const bump = argv.find((a) => !a.startsWith('--') && a !== preid) ?? 'patch';

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', ...opts }).trim();
}

function step(message) {
  process.stdout.write(`  ${message}\n`);
}

function fail(message, hint) {
  process.stderr.write(`\n  error: ${message}\n`);
  if (hint) process.stderr.write(`  ${hint}\n`);
  process.stderr.write('\n');
  process.exit(1);
}

// ---------------------------------------------------------------- preflight

process.stdout.write('\n  Preflight\n');

const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch !== 'main') {
  fail(
    `on branch '${branch}', expected 'main'.`,
    'Releases are cut from main so the tag matches what CI tested.'
  );
}
step(`branch      ${branch}`);

if (run('git', ['status', '--porcelain'])) {
  fail(
    'working tree is dirty.',
    'A release must correspond exactly to a commit; commit or stash first.'
  );
}
step('working tree clean');

// A tag pointing at a commit nobody else has is a release nobody can reproduce.
run('git', ['fetch', 'origin', '--tags', '--quiet']);
const local = run('git', ['rev-parse', 'HEAD']);
let remote = '';
try {
  remote = run('git', ['rev-parse', 'origin/main']);
} catch {
  fail('origin/main not found.', 'Push main before releasing: git push -u origin main');
}
if (local !== remote) {
  fail(
    'local main differs from origin/main.',
    'Pull and push first, so the tag points at a commit that exists on the remote.'
  );
}
step('in sync with origin/main');

const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const currentVersion = pkg.version;

// Compute the next version without writing anything yet.
const nextVersion = run('npm', [
  'version', bump,
  ...(bump.startsWith('pre') ? ['--preid', preid] : []),
  '--no-git-tag-version', '--no-commit-hooks',
]).replace(/^v/, '');

// npm version already wrote package.json; undo it until the checks pass, so a
// failed preflight never leaves a half-bumped tree behind.
run('git', ['checkout', '--', 'package.json', 'package-lock.json']);

step(`version     ${currentVersion} -> ${nextVersion}`);

if (run('git', ['tag', '-l', `v${nextVersion}`])) {
  fail(
    `tag v${nextVersion} already exists.`,
    'Choose a different bump, or delete the tag if it was never pushed.'
  );
}

try {
  run('npm', ['view', `cgraph@${nextVersion}`, 'version']);
  fail(
    `cgraph@${nextVersion} is already on npm.`,
    'Published versions are immutable. Bump to a new version.'
  );
} catch (err) {
  // A non-zero exit is the expected, healthy case: the version is unpublished.
  if (String(err.stdout ?? '').includes(nextVersion)) throw err;
}
step('version is unpublished');

process.stdout.write('\n  Verification\n');
try {
  run('npm', ['test'], { stdio: 'inherit' });
} catch {
  fail('tests failed.', 'A release must be green.');
}
step('tests pass');

// ---------------------------------------------------------------- confirm

const isPrerelease = nextVersion.includes('-');
const npmTag = isPrerelease ? nextVersion.split('-')[1].split('.')[0] : 'latest';

process.stdout.write('\n  Plan\n');
step(`publish     cgraph@${nextVersion}  (npm dist-tag: ${npmTag})`);
step(`tag         v${nextVersion}`);
step(`release     ${REPO}/releases/tag/v${nextVersion}`);
if (isPrerelease) step('prerelease  will NOT become the default install');

if (dryRun) {
  process.stdout.write('\n  --dry-run: nothing was changed.\n\n');
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(`\n  Push tag v${nextVersion} and trigger release? [y/N] `);
rl.close();
if (!/^y(es)?$/i.test(answer.trim())) {
  process.stdout.write('\n  Aborted; nothing was changed.\n\n');
  process.exit(0);
}

// ---------------------------------------------------------------- apply

process.stdout.write('\n  Releasing\n');

run('npm', ['version', nextVersion, '--no-git-tag-version', '--no-commit-hooks']);
step('package.json bumped');

updateChangelog(nextVersion);
step('CHANGELOG updated');

run('git', ['add', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
run('git', ['commit', '-m', `Release v${nextVersion}`]);
run('git', ['tag', '-a', `v${nextVersion}`, '-m', `v${nextVersion}`]);
step(`committed and tagged v${nextVersion}`);

run('git', ['push', 'origin', 'main']);
run('git', ['push', 'origin', `v${nextVersion}`]);
step('pushed');

process.stdout.write(`
  Done. The tag triggers the Release workflow, which will:
    1. re-run tests, benchmark, and a packed-tarball smoke test
    2. publish to npm with provenance (via OIDC, no token)
    3. create the GitHub Release

  Watch it:  ${REPO}/actions
  Release:   ${REPO}/releases/tag/v${nextVersion}

`);

/**
 * Promote the Unreleased section to the new version and open a fresh one.
 * Done here rather than by hand because a release whose changelog says
 * "Unreleased" is a release nobody can read.
 */
function updateChangelog(version) {
  const file = path.join(ROOT, 'CHANGELOG.md');
  let text = fs.readFileSync(file, 'utf8');
  const today = new Date().toISOString().slice(0, 10);

  if (!/^## \[Unreleased\]\s*$/m.test(text)) {
    process.stderr.write('  warning: no [Unreleased] heading found; changelog left alone\n');
    return;
  }

  text = text.replace(
    /^## \[Unreleased\]\s*$/m,
    `## [Unreleased]\n\n## [${version}] — ${today}`
  );

  if (!text.includes(`[${version}]: `)) {
    text = text.replace(
      /^\[Unreleased\]:.*$/m,
      `[Unreleased]: ${REPO}/compare/v${version}...HEAD\n[${version}]: ${REPO}/releases/tag/v${version}`
    );
  }

  fs.writeFileSync(file, text);
}
