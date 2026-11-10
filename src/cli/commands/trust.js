/**
 * `cgraph trust` — allow this project to run its own packs and use its
 * embeddings settings.
 *
 * Deliberately a separate, explicit command rather than a flag on `init` or a
 * prompt. `init` is exactly what someone runs on a repository they just
 * cloned, and a prompt in a tool that agents drive non-interactively is a
 * prompt nobody reads. The decision is recorded outside the project (see
 * core/trust.js), so a repository cannot make it for you.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../core/config.js';
import { isTrusted, trustProject, untrustProject } from '../../core/trust.js';
import { out, json, color } from '../ui.js';

export async function run(args) {
  if (args.help) return help();

  const config = loadConfig(process.cwd(), args.root ? { root: args.root } : {});
  const sub = args._[0] ?? 'grant';

  switch (sub) {
    case 'grant':  return grant(config);
    case 'revoke': return revoke(config);
    case 'status': return status(config, args);
    default:
      throw new Error(`unknown subcommand '${sub}'. Use: status, revoke (or no subcommand to trust)`);
  }
}

/**
 * What trusting this project would actually switch on. Shown before and after
 * the decision, because "trust this project" means nothing without the list of
 * things being trusted.
 */
function gated(config) {
  const packs = [];
  const sources = [
    { base: path.join(config.dir, 'packs'), prefix: '' },
    { base: path.join(config.root, 'node_modules'), prefix: 'cgraph-pack-' },
  ];
  for (const { base, prefix } of sources) {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory() && e.name.startsWith(prefix)) {
        packs.push(path.relative(config.root, path.join(base, e.name)).replace(/\\/g, '/'));
      }
    }
  }

  const e = config.embeddings;
  const embeddings = e?.enabled
    ? { provider: e.provider, baseUrl: e.baseUrl ?? '(provider default)', apiKeyEnv: e.apiKeyEnv ?? '(provider default)' }
    : null;

  return { packs, embeddings };
}

function describe(config) {
  const { packs, embeddings } = gated(config);
  if (!packs.length && !embeddings) {
    out(color.dim('  Nothing in this project needs it right now: no project packs, embeddings off.'));
    return;
  }
  for (const p of packs) out(`    ${color.cyan('runs code')}   ${p}`);
  if (embeddings) {
    out(`    ${color.cyan('sends code')}  to ${embeddings.baseUrl} (${embeddings.provider})`);
    out(`    ${color.cyan('sends key')}   from $${embeddings.apiKeyEnv}`);
  }
}

function grant(config) {
  const added = trustProject(config.root);
  out('');
  out(`  ${added ? color.green('trusted') : color.dim('already trusted')}  ${config.root}`);
  out('');
  describe(config);
  out('');
  out(color.dim('  Undo with `cgraph trust revoke`.'));
  out('');
}

function revoke(config) {
  const removed = untrustProject(config.root);
  out('');
  out(`  ${removed ? color.green('revoked') : color.dim('was not trusted')}  ${config.root}`);
  out('');
}

function status(config, args) {
  const trusted = isTrusted(config.root);
  if (args.json) return json({ root: config.root, trusted, ...gated(config) });

  out('');
  out(`  ${trusted ? color.green('trusted') : color.yellow('not trusted')}  ${config.root}`);
  out('');
  describe(config);
  if (!trusted) {
    out('');
    out(color.dim('  Review the above, then run `cgraph trust` to allow it.'));
  }
  out('');
}

function help() {
  out(`
${color.bold('cgraph trust')} — let this project run its own packs and embeddings

  cgraph trust            Trust this project
  cgraph trust status     Is it trusted, and what would that enable
  cgraph trust revoke     Stop trusting it

${color.bold('WHY THIS EXISTS')}
  Indexing only reads files — except for two things a project can carry:

    .cgraph/packs/*, node_modules/cgraph-pack-*   JavaScript, executed on load
    embeddings in .cgraph/config.json             a URL to send code to, and
                                                  the env var sent as its key

  Neither is used until you trust the project, so opening a repository you
  just cloned cannot run its code or post your credentials somewhere. Builtin
  packs and packs in ~/.cgraph/packs are yours and are never affected.

  The decision is stored in ~/.cgraph/trusted.json, outside the project.
  Set CGRAPH_TRUST=1 instead in CI, where the checkout is all there is.

${color.bold('OPTIONS')}
  --root <dir>   Project directory (default: nearest .cgraph or .git)
  --json         Machine-readable status
`);
}
