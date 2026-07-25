/**
 * `cgraph init` — set up a project and register the MCP server.
 *
 * This is the only command that modifies files outside `.cgraph/`, so it is
 * conservative by design: it never overwrites an existing MCP entry, never
 * rewrites a config file it cannot parse, and reports every change it made.
 * A tool that silently edits a developer's editor config loses trust
 * permanently.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, saveConfig, projectDir } from '../../core/config.js';
import { Store } from '../../core/store.js';
import { Indexer } from '../../core/indexer.js';
import { PackRegistry } from '../../packs/registry.js';
import { out, color, Progress, toks, duration } from '../ui.js';

/** Agent configs we know how to register in, relative to the project root. */
const TARGETS = [
  { file: '.mcp.json',            key: 'mcpServers', label: 'Claude Code' },
  { file: '.cursor/mcp.json',     key: 'mcpServers', label: 'Cursor' },
  { file: '.vscode/mcp.json',     key: 'servers',    label: 'VS Code' },
  { file: '.windsurf/mcp.json',   key: 'mcpServers', label: 'Windsurf' },
];

export async function run(args) {
  if (args.help) return help();

  const root = args.root ? path.resolve(args.root) : process.cwd();
  const config = loadConfig(root, { root });

  out('');
  out(`${color.bold('cgraph')} init  ${root}`);
  out('');

  fs.mkdirSync(projectDir(root), { recursive: true });

  // 1. Index -----------------------------------------------------------------
  const store = await Store.open(config.db);
  let stats;
  try {
    const registry = await PackRegistry.load(config);
    const progress = new Progress('  indexing', { quiet: args.quiet });
    stats = await new Indexer({ store, config, registry, progress }).run({});
    progress.done();

    const s = store.stats();
    out(`  indexed   ${s.parsed} files, ${s.nodes} symbols, ${s.edges} edges`);
    out(`            ~${toks(s.tok)} tokens of source  ·  ${duration(stats.durationMs)}`);

    const gaps = registry.gaps();
    if (gaps.length) {
      // Honesty about coverage up front. A user whose main language has no
      // queries yet should learn it here, not by wondering why find is empty.
      out('');
      out(color.yellow(`  no extraction queries yet for: ${gaps.join(', ')}`));
      out(color.dim('            these files are listed by map but have no symbols'));
    }
    registry.dispose();
  } finally {
    store.close();
  }

  // 2. Config ----------------------------------------------------------------
  const configFile = saveConfig(root, config);

  // 3. .gitignore ------------------------------------------------------------
  const ignored = ensureGitignore(root);

  // 4. MCP registration ------------------------------------------------------
  // The arg parser turns `--no-mcp` into `mcp: false`, which is the standard
  // convention; `noMcp` is accepted too so both spellings behave.
  const skipMcp = args.mcp === false || args.noMcp === true;
  const registered = skipMcp ? [] : registerMcp(root);

  out('');
  out(`  ${color.green('created')}   .cgraph/`);
  if (ignored) out(`  ${color.green('updated')}   .gitignore`);
  for (const r of registered) {
    out(`  ${r.skipped ? color.dim('exists ') : color.green('created')}   ${r.file}  ${color.dim(r.label)}`);
  }

  out('');
  if (registered.some((r) => !r.skipped)) {
    out('  Restart your agent to pick up the MCP server.');
  } else if (!registered.length && !skipMcp) {
    out('  No agent config found. To register manually, add this MCP server:');
    out(color.dim(`    { "command": "cgraph", "args": ["serve", "--root", "${root.replace(/\\/g, '/')}"] }`));
  }
  out(`  Try: ${color.cyan('cgraph map')}  ·  ${color.cyan('cgraph find <symbol>')}  ·  ${color.cyan('cgraph graph <symbol> --dir impact')}`);
  out('');
}

/**
 * Append `.cgraph/` to .gitignore if absent.
 *
 * The index is a build artifact — machine-specific paths, constantly rewritten.
 * Committing it produces enormous diffs on every branch switch.
 */
function ensureGitignore(root) {
  const file = path.join(root, '.gitignore');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // No .gitignore, and not a git repo either: creating one would be presumptuous.
    if (!fs.existsSync(path.join(root, '.git'))) return false;
  }

  if (/^\.cgraph\/?\s*$/m.test(text)) return false;

  const prefix = text && !text.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${prefix}\n# cgraph index (machine-specific, regenerated)\n.cgraph/\n`);
  return true;
}

/**
 * Register the MCP server in whichever agent configs exist.
 *
 * Only writes to a config whose directory already exists — creating
 * `.cursor/` in a project that does not use Cursor is noise. `.mcp.json` at the
 * root is the exception: it is the portable default and is created if missing.
 */
function registerMcp(root) {
  const results = [];

  for (const target of TARGETS) {
    const file = path.join(root, target.file);
    const dir = path.dirname(file);
    const isRootDefault = target.file === '.mcp.json';

    if (!fs.existsSync(file) && !isRootDefault && !fs.existsSync(dir)) continue;

    let json = {};
    if (fs.existsSync(file)) {
      try {
        json = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // Never clobber a config we cannot understand — it is the user's file
        // and may contain settings we would destroy.
        results.push({ file: target.file, label: `${target.label} (unparseable, skipped)`, skipped: true });
        continue;
      }
    }

    json[target.key] ??= {};
    if (json[target.key]['cgraph']) {
      results.push({ file: target.file, label: target.label, skipped: true });
      continue;
    }

    json[target.key]['cgraph'] = {
      command: 'cgraph',
      args: ['serve', '--root', root.replace(/\\/g, '/')],
    };

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
    results.push({ file: target.file, label: target.label, skipped: false });
  }

  return results;
}

function help() {
  out(`
${color.bold('cgraph init')} — index this project and register the MCP server

  cgraph init              Index, write .cgraph/, register with your agent
  cgraph init --no-mcp     Index only; do not touch agent configs

${color.bold('OPTIONS')}
  --root <dir>   Project directory (default: current)
  --no-mcp       Skip MCP registration
  --quiet        No progress output
`);
}
