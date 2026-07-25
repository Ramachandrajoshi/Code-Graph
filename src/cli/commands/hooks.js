/**
 * `cgraph hooks` — keep the index warm across git operations.
 *
 * Strictly optional. The MCP server already refreshes before answering, so the
 * graph is never stale without these. What hooks buy is *latency*: a branch
 * switch or a rebase changes hundreds of files at once, and without a hook the
 * agent's next question pays for re-indexing all of them. The hook moves that
 * cost to the git command, where a pause is expected.
 *
 * Hooks are appended between markers and never replace an existing file. A tool
 * that overwrites someone's pre-existing post-commit hook has destroyed work
 * that may not be recoverable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../core/config.js';
import { out, color } from '../ui.js';

/**
 * Which git events change enough files to be worth pre-warming.
 *
 * post-commit is deliberately absent by default: committing does not change
 * the working tree, so the index is already correct. Adding latency to every
 * commit to re-derive a state that has not changed is a bad trade.
 */
const HOOKS = {
  'post-checkout': 'branch switches and file restores',
  'post-merge': 'merges and pulls',
  'post-rewrite': 'rebases and amends',
};

const MARK_START = '# >>> cgraph >>>';
const MARK_END = '# <<< cgraph <<<';

export async function run(args) {
  if (args.help) return help();

  const config = loadConfig(process.cwd(), args.root ? { root: args.root } : {});
  const gitDir = resolveGitDir(config.root);

  if (!gitDir) {
    throw new Error(
      `${config.root} is not a git repository (no .git found).\n` +
      'Hooks are optional — the MCP server refreshes the index on its own.'
    );
  }

  const sub = args._[0] ?? 'status';
  const hooksDir = path.join(gitDir, 'hooks');

  switch (sub) {
    case 'install': return install(hooksDir, config, args);
    case 'uninstall': return uninstall(hooksDir);
    case 'status': return status(hooksDir);
    default:
      throw new Error(`unknown subcommand '${sub}'. Use: install, uninstall, status`);
  }
}

function install(hooksDir, config, args) {
  fs.mkdirSync(hooksDir, { recursive: true });

  const names = args.all ? [...Object.keys(HOOKS), 'post-commit'] : Object.keys(HOOKS);
  const results = names.map((name) => installOne(hooksDir, name, config));

  out('');
  for (const r of results) {
    const tag = r.status === 'installed' ? color.green('installed')
      : r.status === 'exists' ? color.dim('already  ')
      : color.yellow('skipped  ');
    out(`  ${tag} ${r.name.padEnd(16)} ${color.dim(HOOKS[r.name] ?? 'every commit')}`);
  }

  out('');
  out(color.dim('  These only pre-warm the index. The MCP server refreshes before'));
  out(color.dim('  answering regardless, so nothing goes stale without them.'));
  out('');
}

function installOne(hooksDir, name, config) {
  const file = path.join(hooksDir, name);
  const body = hookBody(config.root);

  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    // No hook yet: write a complete one.
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return { name, status: 'installed' };
  }

  if (existing.includes(MARK_START)) return { name, status: 'exists' };

  // Someone else's hook is here. Append rather than replace, and keep whatever
  // shebang and behaviour they already had.
  const separator = existing.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(file, `${separator}\n${body}\n`);
  try { fs.chmodSync(file, 0o755); } catch { /* Windows has no exec bit */ }
  return { name, status: 'installed' };
}

/**
 * The hook body.
 *
 * Backgrounded and silenced: a hook that blocks `git checkout` or prints noise
 * on every merge gets uninstalled within a day. Failure is swallowed for the
 * same reason — a stale index must never make a git command look broken.
 */
function hookBody(root) {
  const rootArg = root.replace(/\\/g, '/');
  return `${MARK_START}
# Pre-warms the cgraph index so the next agent query does not pay for it.
# Backgrounded and silent by design: this must never delay or fail a git command.
# Remove with: cgraph hooks uninstall
command -v cgraph >/dev/null 2>&1 && (cgraph update --quiet --root "${rootArg}" >/dev/null 2>&1 &)
${MARK_END}`;
}

function uninstall(hooksDir) {
  const removed = [];

  for (const name of [...Object.keys(HOOKS), 'post-commit']) {
    const file = path.join(hooksDir, name);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes(MARK_START)) continue;

    const start = text.indexOf(MARK_START);
    const end = text.indexOf(MARK_END);
    const cleaned = (text.slice(0, start) + text.slice(end + MARK_END.length)).replace(/\n{3,}/g, '\n\n');

    // A hook that is now nothing but a shebang was ours alone; remove the file
    // rather than leaving an empty one behind.
    if (/^#!.*\n\s*$/.test(cleaned) || !cleaned.trim()) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, cleaned);

    removed.push(name);
  }

  out('');
  if (!removed.length) out('  no cgraph hooks were installed');
  else for (const name of removed) out(`  ${color.green('removed')} ${name}`);
  out('');
}

function status(hooksDir) {
  out('');
  out(color.bold('  git hooks'));
  out('');
  for (const [name, why] of Object.entries({ ...HOOKS, 'post-commit': 'every commit' })) {
    let installed = false;
    try {
      installed = fs.readFileSync(path.join(hooksDir, name), 'utf8').includes(MARK_START);
    } catch { /* absent */ }
    const tag = installed ? color.green('yes') : color.dim(' no');
    out(`  ${tag}  ${name.padEnd(16)} ${color.dim(why)}`);
  }
  out('');
  out(color.dim('  cgraph hooks install    pre-warm on checkout, merge and rebase'));
  out('');
}

/**
 * The `.git` directory, following the gitdir pointer used by worktrees and
 * submodules, where `.git` is a file rather than a directory.
 */
function resolveGitDir(root) {
  const dotGit = path.join(root, '.git');
  let stat;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return null;
  }

  if (stat.isDirectory()) return dotGit;

  try {
    const pointer = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (!pointer) return null;
    return path.isAbsolute(pointer) ? pointer : path.resolve(root, pointer);
  } catch {
    return null;
  }
}

function help() {
  out(`
${color.bold('cgraph hooks')} — pre-warm the index across git operations

  cgraph hooks status      Which hooks are installed
  cgraph hooks install     Install into .git/hooks
  cgraph hooks install --all   ...including post-commit
  cgraph hooks uninstall   Remove them

${color.bold('WHEN THIS HELPS')}
  Nothing goes stale without hooks — the MCP server refreshes before it
  answers. Hooks only move the cost: a branch switch changes hundreds of
  files, and without one the agent's next question pays to re-index them.

  post-checkout   branch switches and file restores
  post-merge      merges and pulls
  post-rewrite    rebases and amends

  post-commit is excluded by default. Committing does not change the working
  tree, so the index is already correct; --all adds it anyway.

${color.bold('SAFETY')}
  Existing hooks are appended to, never replaced, between marker comments.
  The hook is backgrounded and silent, so it cannot delay or fail a git
  command.
`);
}
