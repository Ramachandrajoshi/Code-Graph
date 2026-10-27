/**
 * `cgraph skill` — install cgraph as an Agent Skill.
 *
 * The lowest-friction integration there is. MCP needs a config entry per agent
 * shape, a restart, and (for Claude Code) a permission pre-approval. A Skill is
 * one file the harness discovers on its own: no restart, no prompt, nothing to
 * get right in a config format. It teaches the agent to drive the `cgraph` CLI,
 * which never has a connection to fail.
 *
 * Strictly additive and idempotent, like `init`: re-running refreshes the skill
 * in place and never creates a file it cannot recognise as ours.
 */

import path from 'node:path';
import { installSkill, uninstallSkill, skillStatus, SCOPES } from '../../skills.js';
import { out, json, color } from '../ui.js';

export async function run(args) {
  if (args.help) return help();

  const root = args.root ? path.resolve(args.root) : process.cwd();
  const scope = args.global ? 'global' : 'project';
  const sub = args._[0] ?? 'install';

  switch (sub) {
    case 'install':   return install(root, scope, args);
    case 'uninstall': return uninstall(root, scope, args);
    case 'status':    return status(root, args);
    default:
      throw new Error(`unknown subcommand '${sub}'. Use: install, uninstall, status`);
  }
}

function install(root, scope, args) {
  const result = installSkill(root, { scope });
  const tag = {
    created: color.green('created '),
    updated: color.green('updated '),
    current: color.dim('current '),
  }[result.status];

  out('');
  out(`  ${tag}  ${result.file}  ${color.dim(SCOPES[scope].label)}`);
  out('');
  if (result.status === 'current') {
    out(color.dim('  The skill is already up to date.'));
  } else {
    out('  The harness discovers it on its own — no restart needed.');
  }
  out('');
}

function uninstall(root, scope, args) {
  const result = uninstallSkill(root, { scope });
  const tag = {
    removed: color.green('removed '),
    absent: color.dim('absent  '),
    foreign: color.yellow('skipped '),
  }[result.status];

  out('');
  out(`  ${tag}  ${result.file}  ${color.dim(SCOPES[scope].label)}`);
  if (result.status === 'foreign') {
    out(color.yellow('  Not a cgraph skill — left untouched. Remove it by hand.'));
  }
  out('');
}

function status(root, args) {
  const rows = skillStatus(root);
  if (args.json) return json(rows);

  out('');
  out(color.bold('  agent skills'));
  out('');
  for (const r of rows) {
    const tag = {
      current: color.green('yes'),
      stale: color.yellow('stale'),
      absent: color.dim(' no'),
      foreign: color.yellow('own'),
    }[r.status];
    out(`  ${tag}  ${r.scope.padEnd(8)} ${r.file}`);
  }
  out('');
  out(color.dim('  cgraph skill install      add the skill to this project'));
  out(color.dim('  cgraph skill install --global   add it to your machine'));
  out('');
}

function help() {
  out(`
${color.bold('cgraph skill')} — install cgraph as an Agent Skill

  cgraph skill install             Add SKILL.md to this project (.claude/skills)
  cgraph skill install --global    Add it to your machine (~/.claude/skills)
  cgraph skill uninstall           Remove the project skill
  cgraph skill status              Show where the skill is installed

  A Skill is the lightest integration: one file, discovered by the harness with
  no MCP config, no restart, and no permission prompt. It teaches the agent to
  run the \`cgraph\` CLI. Use \`init\` for the MCP tools as well.

${color.bold('OPTIONS')}
  --global       Operate on the machine-wide skill instead of the project's
  --root <dir>   Project directory (default: current)
`);
}
